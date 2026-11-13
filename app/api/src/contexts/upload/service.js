// Context upload — the three steps of the wizard: analyze, preview, apply.
//
// Each step re-reads the draft (drafts.js) and re-derives what it needs from
// the file, so nothing is held between requests and preview and apply can never
// disagree about the file. Apply writes ONLY through the ingest: the list's
// system, its contexts and their members via runIngest (the code behind
// POST /api/ingest/<entity>), Responsibles and SameUnitAs links via the
// context-links writers. Design: docs/architecture/context-upload.md.

import { parseList } from './parse.js';
import { profileColumns } from './profile.js';
import { guessMapping } from './guess.js';
import { refineGuess } from './aiRefine.js';
import { checkMapping } from './mapping.js';
import { planUnits, ROOT_KEY } from './plan.js';
import { matchAll } from './members.js';
import {
  buildContextRecords, buildMemberRecords, buildResponsibleRows, buildOwnerRows, buildLinkRows, memberValues, treeKinds, contextIdFor, keptRecord,
} from './records.js';
import { diffContexts } from './diff.js';
import { saveDraft, loadDraft, deleteDraft, sweepDrafts } from './drafts.js';
import {
  UPLOAD_SYSTEM_TYPE, systemNameFor, findList, findListByName, existingContexts, syncMembershipsOf, recordUpload,
} from './lists.js';

export class UploadError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const MAX_SAMPLE_UNITS = 10;

// The saved mapping of an existing list, when every column it names is still in
// the file — the natural starting point of a re-import. Null otherwise.
function savedMappingFits(list, columns) {
  if (!list?.mapping) return null;
  const { mapping, errors } = checkMapping(list.mapping, columns);
  return errors.length === 0 ? mapping : null;
}

/**
 * Step 1: store the file, describe its columns and guess the mapping.
 * @returns {Promise<object>} { uploadDraftId, fileName, rowCount, columns, guess, aiUsed, aiFields, existingList }
 */
export async function analyzeUpload({ buffer, fileName, uploadedBy, listId = null }, { db, refine = refineGuess } = {}) {
  await sweepDrafts();
  const { columns, rows } = await parseList(buffer, { fileName });
  const profile = profileColumns(columns, rows);
  const chosen = listId ? await findList(db, listId) : null;
  if (listId && !chosen) throw new UploadError(404, 'That uploaded list does not exist any more.');

  const heuristic = guessMapping({ fileName, profile, rowCount: rows.length });
  const saved = savedMappingFits(chosen, columns);
  const refined = saved ? { mapping: saved, aiUsed: false, aiFields: [] } : await refine({ fileName, profile, guess: heuristic });
  const guess = chosen ? { ...refined.mapping, listName: listNameOf(chosen) } : refined.mapping;
  // A new file whose name matches a list already uploaded: offer it, don't assume.
  const existingList = chosen ?? await findListByName(db, guess.listName);

  const uploadDraftId = await saveDraft(buffer, { fileName, uploadedBy });
  return {
    uploadDraftId,
    fileName,
    rowCount: rows.length,
    columns: profile.map(c => ({ header: c.name, samples: c.samples, shape: c.shape, filled: c.nonEmpty, distinct: c.distinct })),
    guess,
    aiUsed: refined.aiUsed,
    aiFields: refined.aiFields,
    existingList: existingList ? summarizeList(existingList) : null,
  };
}

const listNameOf = (list) => list.displayName.replace(/ \(upload\)$/, '');
const summarizeList = (list) => ({
  id: list.id, listName: listNameOf(list), lastFileName: list.fileName ?? null,
  lastUploadedAt: list.uploadedAt ?? null, rootContextId: list.rootContextId ?? null,
});

// The accounts a set of values names (Responsibles, owners), or null for none.
async function matchAccounts(db, values) {
  const distinct = [...new Set(values)];
  return distinct.length ? matchAll(db, { Principal: distinct }) : null;
}

// Shared by preview and apply: the draft, the checked mapping, the plan, the
// list (when updating one) and the member matches. Throws UploadError for
// anything the analyst has to fix.
async function prepare({ uploadDraftId, mapping: input, listId }, db) {
  const draft = await loadDraft(uploadDraftId);
  if (!draft) throw new UploadError(410, 'The uploaded file has expired or is unknown; upload it again.');
  const { columns, rows } = await parseList(draft.buffer, { fileName: draft.fileName });
  const { mapping, errors } = checkMapping(input, columns);
  if (errors.length) throw new UploadError(400, 'The mapping is not complete.', errors);
  const list = listId ? await findList(db, listId) : null;
  if (listId && !list) throw new UploadError(404, 'That uploaded list does not exist any more.');
  // A list keeps its name: its system is named after it.
  if (list) mapping.listName = listNameOf(list);
  const plan = planUnits(rows, mapping);
  const matches = await matchAll(db, memberValues(plan.units));
  const responsibles = await matchAccounts(db, plan.units.flatMap(u => u.responsibles));
  const owners = await matchAccounts(db, plan.units.map(u => u.owner).filter(Boolean));
  return { draft, rows, mapping, list, plan, matches, responsibles, owners };
}

function previewOf({ rows, plan, matches, responsibles, owners }, records, existing) {
  const diff = diffContexts(records, existing);
  return {
    rowCount: rows.length,
    unitCount: plan.units.length,
    trees: records.filter(r => r.externalId === ROOT_KEY).map(r => ({ name: r.displayName, kind: r.targetType })),
    contexts: { created: diff.created, updated: diff.updated, unchanged: diff.unchanged, notInFile: diff.missingIds.length },
    members: matches.stats,
    responsibles: responsibles?.stats ?? null,
    owners: owners?.stats ?? null,
    errors: plan.errors,
    warnings: plan.warnings,
    sample: plan.units.slice(0, MAX_SAMPLE_UNITS).map(u => ({ key: u.key, name: u.name, parentKey: u.parentKey, owner: u.owner })),
  };
}

/** Step 2: what apply would do, without writing. */
export async function previewUpload(body, { db }) {
  const prep = await prepare(body, db);
  // A new list has no system yet, so no contexts: everything is created. Any id
  // will do for the records — only the counts are read.
  const systemId = prep.list?.id ?? 0;
  const records = buildContextRecords(prep.plan.units, prep.mapping, systemId);
  const existing = await existingContexts(db, prep.list?.id);
  return previewOf(prep, records, existing);
}

// The ingest takes at most 50,000 records per batch. Two trees of a 50,000-row
// list, or its memberships, can be more: those go as one ingest session (start /
// continue / end), which reconciles the whole set at its end exactly as a single
// full batch would.
export const BATCH_LIMIT = 50_000;
const succeeded = (out) => out.status >= 200 && out.status < 300;

export async function ingestAll(runIngest, entity, body, limit = BATCH_LIMIT) {
  const { records } = body;
  if (records.length <= limit) return runIngest(entity, body);
  const chunks = [];
  for (let i = 0; i < records.length; i += limit) chunks.push(records.slice(i, i + limit));
  let out = await runIngest(entity, { ...body, records: chunks[0], syncSession: 'start' });
  const syncId = out.body?.syncId;
  for (const [i, chunk] of chunks.slice(1).entries()) {
    if (!succeeded(out)) return out;
    const step = i === chunks.length - 2 ? 'end' : 'continue';
    out = await runIngest(entity, { ...body, records: chunk, syncSession: step, syncId });
  }
  return out;
}

function ingestOrThrow(out, what) {
  if (succeeded(out)) return out.body;
  const message = out.body?.error || `Writing the ${what} failed.`;
  throw new UploadError(out.status === 400 || out.status === 422 ? 422 : 500, `${message} (${what})`, out.body?.details);
}

// The list's system: the chosen one, or a new one — never silently another
// list of the same name (analyze offered it; the analyst chose a new list).
async function resolveSystem(prep, deps) {
  if (prep.list) return prep.list.id;
  if (await findListByName(deps.db, prep.mapping.listName)) {
    throw new UploadError(409, `A list called "${prep.mapping.listName}" was uploaded before. Choose it to update it, or give this list another name.`);
  }
  const body = ingestOrThrow(await deps.runIngest('systems', {
    records: [{ displayName: systemNameFor(prep.mapping.listName), systemType: UPLOAD_SYSTEM_TYPE, description: 'A list uploaded in the Contexts tab.' }],
    syncMode: 'delta',
  }), 'list');
  const systemId = body.systemIds?.[0];
  if (!systemId) throw new UploadError(500, 'The list could not be registered.');
  return systemId;
}

// Always a full sync of the list's own contexts, so a cell emptied in the file
// is emptied on the context too (a delta keeps the stored value for an empty
// one). Keeping what the file no longer has is done by sending it back as it is.
async function writeContexts(systemId, records, kept, deps) {
  return ingestOrThrow(await ingestAll(deps.runIngest, 'contexts', {
    systemId,
    records: [...records, ...kept],
    syncMode: 'full',
    scope: { variant: 'synced', scopeSystemId: systemId },
  }), 'contexts');
}

// One full batch for every tree of the list. A context kept although it is not
// in the file keeps its members: they are sent along.
async function writeMembers(systemId, members, keptIds, deps) {
  const kept = await syncMembershipsOf(deps.db, keptIds);
  return ingestOrThrow(await ingestAll(deps.runIngest, 'context-members', {
    systemId, records: [...members, ...kept], syncMode: 'full',
  }), 'members');
}

// The owners this upload matched — by name or as a near miss too, which the
// contexts ingest's own resolution does not take — as their unit's Accountable.
// An Accountable the ingest just set, or an analyst's, stays (insert-only). They
// are written as the owner reconcile's own rows (insertOwnerRows), so the next
// import replaces or removes them as the owner column changes.
// Returns the owner matching with the number written, or null without owners.
async function writeOwners(prep, systemId, deps) {
  if (!prep.owners) return null;
  const rows = buildOwnerRows(prep.plan.units, prep.mapping, systemId, prep.owners.ids.Principal);
  const out = rows.length ? await deps.insertOwnerRows(rows, systemId) : null;
  return { ...prep.owners.stats, written: out?.inserted ?? 0 };
}

/**
 * Step 3: write the list. Returns the result the wizard shows, with the root to select.
 * @param {object} body  { uploadDraftId, mapping, listId?, removeMissing? }
 */
export async function applyUpload(body, uploadedBy, deps) {
  const prep = await prepare(body, deps.db);
  if (prep.plan.errors.length) throw new UploadError(400, 'The list has rows that cannot be imported.', prep.plan.errors);
  const removeMissing = body.removeMissing === true;
  const systemId = await resolveSystem(prep, deps);
  const { units } = prep.plan;
  const records = buildContextRecords(units, prep.mapping, systemId);
  const existing = await existingContexts(deps.db, prep.list ? systemId : null);
  const diff = diffContexts(records, existing);

  const keptIds = removeMissing ? [] : diff.missingIds;
  const keep = new Set(keptIds);
  const kept = existing.filter(row => keep.has(row.id)).map(row => keptRecord(row, systemId));
  const written = await writeContexts(systemId, records, kept, deps);
  const memberRecords = buildMemberRecords(units, prep.mapping, systemId, prep.matches.ids);
  await writeMembers(systemId, memberRecords, keptIds, deps);
  const responsibleRows = prep.responsibles ? buildResponsibleRows(units, prep.mapping, systemId, prep.responsibles.ids.Principal) : [];
  const roles = await deps.insertRoleRows(responsibleRows, systemId);
  const owners = await writeOwners(prep, systemId, deps);
  const links = await deps.insertRelationshipRows(buildLinkRows(units, prep.mapping, systemId), systemId);
  await deps.refreshMemberCounts(deps.db, [...records.map(r => r.id), ...keptIds]);

  const rootContextId = contextIdFor(systemId, treeKinds(prep.mapping)[0], ROOT_KEY);
  const removed = removeMissing ? diff.missingIds.length : 0;
  const unmatched = prep.matches.stats.unmatched + prep.matches.stats.ambiguous;
  const run = await recordUpload(deps.db, {
    systemId, rootContextId, fileName: prep.draft.fileName, template: prep.mapping.template, keyColumn: prep.mapping.keyColumn,
    mapping: prep.mapping, rowCount: prep.rows.length, created: diff.created, updated: diff.updated, unchanged: diff.unchanged,
    removed, unmatchedMembers: unmatched, uploadedBy,
  });
  await deleteDraft(body.uploadDraftId);
  return {
    listId: systemId,
    rootContextId,
    uploadId: run?.id ?? null,
    contexts: { created: diff.created, updated: diff.updated, unchanged: diff.unchanged, removed, notInFile: removeMissing ? 0 : diff.missingIds.length },
    members: { written: memberRecords.length, ...prep.matches.stats },
    accountable: written.accountable ?? null,
    owners,
    responsibles: roles,
    links,
    warnings: prep.plan.warnings,
  };
}
