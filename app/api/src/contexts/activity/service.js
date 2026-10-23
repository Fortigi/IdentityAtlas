// Context activity — the three steps of the upload wizard: analyze, preview, apply.
//
// The list upload's shape (upload/service.js), with the list upload's pieces:
// the file is parsed by upload/parse.js, kept between the steps as a draft
// (upload/drafts.js), profiled by upload/profile.js; each step re-reads it, so
// preview and apply can never disagree about the file. Apply writes one upload
// run and its rows (store.js) — activity only: no membership, no access.
// Design: docs/architecture/context-activity.md.

import { parseList } from '../upload/parse.js';
import { profileColumns } from '../upload/profile.js';
import { saveDraft, loadDraft, deleteDraft, sweepDrafts } from '../upload/drafts.js';
import { UploadError } from '../upload/service.js';
import { guessActivityMapping } from './guess.js';
import { refineActivityGuess } from './aiRefine.js';
import { checkActivityMapping } from './mapping.js';
import { readActivityRows } from './rows.js';
import { matchContexts, matchSubjects, subjectKey } from './match.js';
import { loadContext, descendantsOf, latestUploadOf, replacedBy, writeUpload } from './store.js';

// An activity export is longer than a list: a year of time entries of a few
// hundred people. Not a file-size cap (the large-file policy holds) — a row
// count, refused with a sentence.
export const MAX_ACTIVITY_ROWS = 500_000;
export const ACTIVITY_CATEGORIES = ['OrganizationalUnit', 'LogicalApplication'];
const MAX_SAMPLE_ROWS = 10;
const EMPTY_VALUE = '(empty)';

async function contextOrThrow(db, contextId) {
  const context = await loadContext(db, contextId);
  if (!context) throw new UploadError(404, 'Context not found.');
  if (!ACTIVITY_CATEGORIES.includes(context.contextCategory)) {
    throw new UploadError(400, 'Activity can be uploaded on an organisation unit or an application.');
  }
  return context;
}

// The saved mapping of the latest upload of this source here, when every column it names is still in the file.
function savedMappingFits(saved, columns, hasChildren) {
  if (!saved?.mapping) return null;
  const { mapping, errors } = checkActivityMapping(saved.mapping, columns, { hasChildren });
  return errors.length === 0 ? mapping : null;
}

/**
 * Step 1: store the file, describe its columns and guess the mapping.
 * @returns {Promise<object>} { uploadDraftId, fileName, rowCount, columns, guess, aiUsed, aiFields, hasChildren, subUnitCount, previousUpload }
 */
export async function analyzeActivity({ buffer, fileName, uploadedBy, contextId }, { db, refine = refineActivityGuess } = {}) {
  await sweepDrafts();
  const context = await contextOrThrow(db, contextId);
  const { columns, rows } = await parseList(buffer, { fileName, maxRows: MAX_ACTIVITY_ROWS });
  const profile = profileColumns(columns, rows);
  const units = await descendantsOf(db, context.id);
  const hasChildren = units.length > 0;
  const childNames = units.flatMap(u => [u.displayName, u.externalId]).filter(Boolean);

  const heuristic = guessActivityMapping({ fileName, profile, rows, childNames });
  const previous = await latestUploadOf(db, context.id, heuristic.sourceLabel);
  const saved = savedMappingFits(previous, columns, hasChildren);
  const refined = saved ? { mapping: saved, aiUsed: false, aiFields: [] } : await refine({ fileName, profile, guess: heuristic, hasChildren });

  const uploadDraftId = await saveDraft(buffer, { fileName, uploadedBy });
  return {
    uploadDraftId,
    fileName,
    rowCount: rows.length,
    columns: profile.map(c => ({ header: c.name, samples: c.samples, shape: c.shape, filled: c.nonEmpty, distinct: c.distinct })),
    guess: refined.mapping,
    aiUsed: refined.aiUsed,
    aiFields: refined.aiFields,
    hasChildren,
    subUnitCount: units.length,
    previousUpload: previous ? { id: previous.id, fileName: previous.fileName, uploadedAt: previous.uploadedAt, mappingReused: !!saved } : null,
  };
}

// Row counts per sub-unit value (an empty cell counted as EMPTY_VALUE).
function contextValueCounts(entries) {
  const counts = new Map();
  for (const e of entries) {
    const v = e.contextValue ?? EMPTY_VALUE;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

// The context each entry lands on: the uploaded-on context itself, or the
// matched sub-unit (null: not imported).
function placeEntries(entries, mapping, context, units) {
  if (!mapping.contextColumn) return { placed: entries.map(e => ({ ...e, contextId: context.id })), contexts: null };
  const counts = contextValueCounts(entries);
  counts.delete(EMPTY_VALUE);
  const { ids, stats } = matchContexts(units, counts);
  const placed = entries.map(e => ({ ...e, contextId: e.contextValue ? ids.get(e.contextValue) ?? null : null }));
  const emptyRows = entries.filter(e => !e.contextValue).length;
  return { placed, contexts: { ...stats, emptyRows } };
}

function distinctSubjects(entries) {
  const byKey = new Map();
  for (const e of entries) if (!byKey.has(subjectKey(e))) byKey.set(subjectKey(e), { subjectName: e.subjectName, subjectEmail: e.subjectEmail });
  return [...byKey.values()];
}

// Shared by preview and apply. Throws UploadError for anything the analyst has to fix.
async function prepare({ uploadDraftId, mapping: input }, contextId, db) {
  const draft = await loadDraft(uploadDraftId);
  if (!draft) throw new UploadError(410, 'The uploaded file has expired or is unknown; upload it again.');
  const context = await contextOrThrow(db, contextId);
  const { columns, rows } = await parseList(draft.buffer, { fileName: draft.fileName, maxRows: MAX_ACTIVITY_ROWS });
  const units = await descendantsOf(db, context.id);
  const { mapping, errors } = checkActivityMapping(input, columns, { hasChildren: units.length > 0 });
  if (errors.length) throw new UploadError(400, 'The mapping is not complete.', errors);

  const read = readActivityRows(rows, mapping);
  const { placed, contexts } = placeEntries(read.entries, mapping, context, units);
  const landed = placed.filter(e => e.contextId);
  const subjects = await matchSubjects(db, distinctSubjects(landed));
  const out = landed.map(e => {
    const who = subjects.resolved.get(subjectKey(e));
    return { ...e, principalId: who?.principalId ?? null, identityId: who?.identityId ?? null };
  });
  const replaces = await replacedBy(db, context.id, mapping.sourceLabel, read.period);
  return { draft, context, units, rows, mapping, read, contexts, subjects, out, replaces };
}

const unitName = (units, context) => {
  const names = new Map([[context.id, context.displayName], ...units.map(u => [u.id, u.displayName])]);
  return (id) => names.get(id) ?? null;
};

/** Step 2: what apply would do, without writing. */
export async function previewActivity(body, contextId, { db }) {
  const p = await prepare(body, contextId, db);
  const nameOf = unitName(p.units, p.context);
  const unknownRows = p.out.filter(r => !r.principalId && !r.identityId).length;
  return {
    rowCount: p.rows.length,
    readable: p.read.entries.length,
    skipped: p.read.skipped,
    skippedSamples: p.read.skippedSamples,
    period: p.read.period,
    unit: p.mapping.unit,
    contexts: p.contexts,
    subjects: p.subjects.stats,
    rowsToImport: p.out.length,
    rowsNotPlaced: p.read.entries.length - p.out.length,
    rowsUnknownPerson: unknownRows,
    subUnitsReached: new Set(p.out.map(r => r.contextId)).size,
    replaces: { rows: p.replaces.reduce((s, u) => s + u.rows, 0), uploads: p.replaces },
    sample: p.out.slice(0, MAX_SAMPLE_ROWS).map(r => ({
      context: nameOf(r.contextId), subject: r.subjectName || r.subjectEmail, date: r.date, amount: r.amount, kind: r.kind,
    })),
  };
}

/** Step 3: write the upload. */
export async function applyActivity(body, contextId, uploadedBy, { db }) {
  const p = await prepare(body, contextId, db);
  if (p.out.length === 0) throw new UploadError(400, 'No row of the file can be imported: check the date, amount, person and sub-unit columns.');
  const written = await writeUpload(db, {
    contextId: p.context.id, fileName: p.draft.fileName, sourceLabel: p.mapping.sourceLabel, mapping: p.mapping,
    period: p.read.period, rowCount: p.rows.length, matchedRows: p.out.length, unmatchedRows: p.rows.length - p.out.length,
    uploadedBy, unit: p.mapping.unit,
  }, p.out);
  await deleteDraft(body.uploadDraftId);
  return {
    uploadId: written.uploadId,
    contextId: p.context.id,
    imported: written.inserted,
    replaced: written.replaced,
    notImported: p.rows.length - p.out.length,
    period: p.read.period,
    subjects: p.subjects.stats,
  };
}
