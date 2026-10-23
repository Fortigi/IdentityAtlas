// Survey templates — the steps behind the routes (routes/surveys.js).
//
// Templates (an analyst's):
//   listTemplates({ contextId?, includeArchived? })   all, or the ones that may be sent about a context
//   getTemplate(id)                                   one, with its current definition and its versions
//   createTemplate(body, user)                        a new template (version 1)
//   updateTemplate(id, body, user)                    its fields; changed questions are a new version
//
// Requests:
//   sendSurvey(contextId, body, user)                 to one person, or down the tree to each unit's Accountable
//   contextRequests(contextId)                        the requests about a context
//   cancelSurvey(id)                                  an unanswered one
//   mySurveys(me)                                     the requests sent to the signed-in person
//   openSurvey(id, caller)                            the questions, the rows, the answers so far
//   saveDraft(id, answers, caller)                    keep what is filled in
//   submitSurvey(id, body, caller)                    answers → an interview and its claims
//
// A caller is { me, canWrite, user }: `me` is resolveMe()'s answer (null when
// auth is off or nothing matches), canWrite is data.write.contexts. The
// recipient may open, save and submit their survey; an analyst (canWrite) may
// too — on their behalf, as when the analyst fills it in during the meeting.
// Every refusal is a SurveyError with the status the route answers.
// Design: docs/architecture/survey-templates.md.

import * as defaultDb from '../../db/connection.js';
import { ROLE_BEARING_CATEGORIES } from '../../lib/contextCategories.js';
import * as interviewStore from '../interviews/store.js';
import { checkDefinition, questionsOf } from './definition.js';
import { checkAnswers } from './answers.js';
import { buildResponse } from './response.js';
import * as store from './store.js';

export class SurveyError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'SurveyError';
    this.status = status;
    this.details = details;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const CATEGORIES = Object.freeze(['OrganizationalUnit', 'LogicalApplication']);
export const MAX_NAME = 200;
export const MAX_MESSAGE = 2000;
// Sending down a tree: at most this many units in one go.
export const MAX_TREE = 500;

const defaults = (deps = {}) => ({ db: defaultDb, ...deps });
// A transaction client offers query() only; the store also reads with queryOne().
const txDb = (client) => ({ query: (t, p) => client.query(t, p), queryOne: async (t, p) => (await client.query(t, p)).rows[0] ?? null });
const today = () => new Date().toISOString().slice(0, 10);

function uuid(value, what) {
  const s = String(value ?? '');
  if (!UUID_RE.test(s)) throw new SurveyError(400, `${what} must be a uuid`);
  return s.toLowerCase();
}

/** A key from a name: lower case, words joined by '-'. Pure. */
export function keyFrom(name) {
  return String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'survey';
}

// ─── Templates ───────────────────────────────────────────────────────────

function templateName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > MAX_NAME) throw new SurveyError(400, `Give the template a name (at most ${MAX_NAME} characters).`);
  return name;
}

function templateCategory(value) {
  if (!CATEGORIES.includes(value)) throw new SurveyError(400, `contextCategory must be one of ${CATEGORIES.join(', ')}`);
  return value;
}

/** The template fields of a create (all) or update (only those given) body, or a SurveyError. Pure. */
export function parseTemplateFields(body = {}, { create = false } = {}) {
  const out = {};
  if (create || body.name !== undefined) out.name = templateName(body.name);
  if (body.description !== undefined) out.description = body.description ? String(body.description).trim().slice(0, MAX_MESSAGE) : null;
  if (create || body.contextCategory !== undefined) out.contextCategory = templateCategory(body.contextCategory);
  if (body.scopeRootContextId !== undefined) {
    out.scopeRootContextId = body.scopeRootContextId ? uuid(body.scopeRootContextId, 'scopeRootContextId') : null;
  }
  if (create && body.key !== undefined && !KEY_RE.test(String(body.key))) {
    throw new SurveyError(400, 'key is lower-case letters, digits and -');
  }
  return out;
}

function checkedDefinition(definition) {
  const errors = checkDefinition(definition);
  if (errors.length) throw new SurveyError(400, 'The questions cannot be saved as they are.', { errors });
  return definition;
}

async function checkScopeRoot(db, fields, category) {
  if (!fields.scopeRootContextId) return;
  const root = await store.getContext(db, fields.scopeRootContextId);
  if (!root) throw new SurveyError(404, 'The context the template is limited to does not exist.');
  if (root.contextCategory !== category) {
    throw new SurveyError(400, `The template is for ${category}; "${root.displayName}" is not one.`);
  }
}

async function freeKey(db, wanted) {
  if (!(await store.keyExists(db, wanted))) return wanted;
  for (let i = 2; i < 100; i++) {
    const k = `${wanted}-${i}`;
    if (!(await store.keyExists(db, k))) return k;
  }
  throw new SurveyError(409, 'Choose another name: too many templates have this one.');
}

export async function listTemplates({ contextId = null, includeArchived = false } = {}, deps) {
  const { db } = defaults(deps);
  if (!contextId) return store.listTemplates(db, { includeArchived });
  const id = uuid(contextId, 'contextId');
  if (!(await store.getContext(db, id))) throw new SurveyError(404, 'Context not found');
  return store.applicableTemplates(db, id);
}

export async function getTemplate(id, deps) {
  const { db } = defaults(deps);
  const t = await store.getTemplate(db, uuid(id, 'id'));
  if (!t) throw new SurveyError(404, 'Survey template not found');
  return { ...t, versions: await store.listVersions(db, t.id) };
}

export async function createTemplate(body = {}, user, deps) {
  const { db } = defaults(deps);
  const fields = parseTemplateFields(body, { create: true });
  const definition = checkedDefinition(body.definition);
  await checkScopeRoot(db, fields, fields.contextCategory);
  const key = await freeKey(db, body.key ?? keyFrom(fields.name));
  const id = await db.tx(async (client) => {
    const tdb = txDb(client);
    const newId = await store.insertTemplate(tdb, { ...fields, key, builtIn: !!body.builtIn, createdBy: user });
    await store.insertVersion(tdb, newId, 1, definition, user);
    return newId;
  });
  return getTemplate(id, { db });
}

/** Change a template. A changed definition becomes the next version; requests already sent keep theirs. */
export async function updateTemplate(id, body = {}, user, deps) {
  const { db } = defaults(deps);
  const current = await getTemplate(id, { db });
  const fields = parseTemplateFields(body);
  await checkScopeRoot(db, { scopeRootContextId: fields.scopeRootContextId }, fields.contextCategory ?? current.contextCategory);
  if (body.archived !== undefined) fields.archivedAt = body.archived ? new Date().toISOString() : null;
  const changed = body.definition !== undefined && JSON.stringify(body.definition) !== JSON.stringify(current.definition);
  const definition = changed ? checkedDefinition(body.definition) : null;
  await db.tx(async (client) => {
    const tdb = txDb(client);
    if (changed) {
      fields.currentVersion = current.currentVersion + 1;
      await store.insertVersion(tdb, current.id, fields.currentVersion, definition, user);
    }
    await store.updateTemplate(tdb, current.id, fields);
  });
  return getTemplate(current.id, { db });
}

// ─── Sending ─────────────────────────────────────────────────────────────

/** The body of POST /contexts/:id/surveys → what to send, or a SurveyError. Pure. */
export function parseSend(body = {}) {
  const templateId = uuid(body.templateId, 'templateId');
  const keys = ['principalId', 'identityId'].filter(k => body.recipient?.[k]);
  if (keys.length > 1) throw new SurveyError(400, 'Give the recipient as principalId or identityId, not both.');
  const recipient = keys.length ? { col: keys[0], id: uuid(body.recipient[keys[0]], keys[0]) } : null;
  const dueAt = body.dueAt ? String(body.dueAt) : null;
  if (dueAt && !(DATE_RE.test(dueAt) && !Number.isNaN(Date.parse(`${dueAt}T00:00:00Z`)))) {
    throw new SurveyError(400, 'dueAt must be a date (YYYY-MM-DD).');
  }
  const message = body.message ? String(body.message).trim().slice(0, MAX_MESSAGE) : null;
  const includeSubContexts = body.includeSubContexts === true;
  if (!recipient && !includeSubContexts && body.toAccountable !== true) {
    throw new SurveyError(400, 'Say who receives it: a recipient, or the Accountable.');
  }
  return { templateId, recipient, dueAt, message, includeSubContexts, language: body.language ? String(body.language) : null };
}

// One request per target unit: the named recipient for the unit itself (when
// given), else that unit's Accountable; a unit without either is skipped.
function plan(targets, send, accountables, recipientName) {
  const rows = [];
  const skipped = [];
  targets.forEach((c, i) => {
    const own = i === 0 && send.recipient;
    const acc = accountables.get(c.id);
    if (!own && !acc) { skipped.push({ contextId: c.id, contextName: c.displayName, reason: 'has no Accountable' }); return; }
    rows.push({
      contextId: c.id,
      principalId: own ? (send.recipient.col === 'principalId' ? send.recipient.id : null) : acc.principalId,
      identityId: own ? (send.recipient.col === 'identityId' ? send.recipient.id : null) : acc.identityId,
      recipientName: own ? recipientName : (acc.displayName || 'Accountable'),
      contextName: c.displayName,
    });
  });
  return { rows, skipped };
}

async function sendTargets(db, ctx, send) {
  if (!send.includeSubContexts) return [ctx];
  const tree = await store.contextTree(db, ctx.id);
  if (tree.length > MAX_TREE) throw new SurveyError(400, `That is ${tree.length} units; send to at most ${MAX_TREE} at once.`);
  return tree;
}

export async function sendSurvey(contextId, body, user, deps) {
  const { db } = defaults(deps);
  const ctx = await store.getContext(db, uuid(contextId, 'id'));
  if (!ctx) throw new SurveyError(404, 'Context not found');
  if (!ROLE_BEARING_CATEGORIES.has(ctx.contextCategory)) {
    throw new SurveyError(400, 'Surveys can be sent about an organizational unit or a logical application only.');
  }
  const send = parseSend(body);
  const template = (await store.applicableTemplates(db, ctx.id)).find(t => t.id === send.templateId);
  if (!template) throw new SurveyError(400, 'That survey template cannot be sent about this context.');
  const { definition } = await store.getTemplate(db, template.id);
  if (send.language && !definition.languages.includes(send.language)) {
    throw new SurveyError(400, `The survey is in ${definition.languages.join(', ')}.`);
  }
  const recipientName = send.recipient ? await store.personName(db, send.recipient.col, send.recipient.id) : null;
  if (send.recipient && !recipientName) throw new SurveyError(404, 'The recipient was not found.');

  const targets = await sendTargets(db, ctx, send);
  const accountables = await store.accountablesOf(db, targets.map(t => t.id));
  const { rows, skipped } = plan(targets, send, accountables, recipientName);
  const inserted = await store.insertRequests(db, rows.map(r => ({
    templateId: template.id, templateVersion: template.currentVersion, contextId: r.contextId,
    principalId: r.principalId, identityId: r.identityId, recipientName: r.recipientName,
    language: send.language, message: send.message, dueAt: send.dueAt, sentBy: user ?? null,
  })));
  const names = new Map(rows.map(r => [r.contextId, r]));
  return {
    sent: inserted.map(x => ({ id: x.id, contextId: x.contextId, contextName: names.get(x.contextId).contextName, recipientName: names.get(x.contextId).recipientName })),
    skipped,
  };
}

export async function contextRequests(contextId, deps) {
  const { db } = defaults(deps);
  return store.listContextRequests(db, uuid(contextId, 'id'));
}

export async function cancelSurvey(id, deps) {
  const { db } = defaults(deps);
  const n = await store.cancelRequest(db, uuid(id, 'id'));
  if (!n) throw new SurveyError(404, 'No unanswered survey with this id');
}

// ─── Answering ───────────────────────────────────────────────────────────

/** The requests sent to the signed-in person. */
export async function mySurveys(me, deps) {
  const { db } = defaults(deps);
  if (!me?.principal?.id) return { me: null, data: [] };
  return {
    me: { principalId: me.principal.id, identityId: me.identity?.id ?? null, displayName: me.identity?.displayName ?? me.principal.displayName },
    data: await store.requestsFor(db, me.principal.id, me.identity?.id ?? null),
  };
}

const ROW_SQL = { members: store.MEMBER_ROWS_SQL, resources: store.RESOURCE_ROWS_SQL, children: store.CHILD_ROWS_SQL };
const PEOPLE = new Set(['Principal', 'Identity']);

// Which contexts' members a per-row question reads: the unit itself when it
// holds that kind, else its SameUnitAs variants of that kind (people before accounts).
export function rowContexts(source, variants) {
  if (source === 'children') return variants.filter(v => v.self).map(v => v.id);
  if (source === 'resources') return variants.filter(v => v.targetType === 'Resource').map(v => v.id);
  const self = variants.find(v => v.self);
  if (self && PEOPLE.has(self.targetType)) return [self.id];
  const people = variants.filter(v => v.targetType === 'Identity');
  return (people.length ? people : variants.filter(v => v.targetType === 'Principal')).map(v => v.id);
}

/** A row as the form and the claims read it: { id, kind, displayName, columns }. Pure. */
export function toRow(r) {
  const { id, kind, displayName, ...columns } = r;
  return { id: String(id).toLowerCase(), kind, displayName: displayName || String(id), columns: { displayName, ...columns } };
}

/** The rows of every per-row question of a definition: { [questionId]: rows }. One query per source. */
export async function loadRows(db, contextId, definition) {
  const sources = [...new Set(questionsOf(definition).filter(q => q.rows).map(q => q.rows.source))];
  if (sources.length === 0) return {};
  const variants = await store.unitVariants(db, contextId);
  const bySource = {};
  for (const s of sources) {
    const ids = rowContexts(s, variants);
    const rows = ids.length ? await store.rowsFrom(db, ROW_SQL[s], ids) : [];
    bySource[s] = rows.map(toRow).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  return Object.fromEntries(questionsOf(definition).filter(q => q.rows).map(q => [q.id, bySource[q.rows.source]]));
}

const rowIdSets = (rows) => Object.fromEntries(Object.entries(rows).map(([q, list]) => [q, new Set(list.map(r => r.id))]));

async function callerRequest(db, id, caller) {
  const request = await store.getRequest(db, uuid(id, 'id'));
  if (!request) throw new SurveyError(404, 'Survey not found');
  const me = caller.me?.principal?.id ? caller.me : null;
  const recipient = me ? await store.isRecipient(db, request.id, me.principal.id, me.identity?.id ?? null) : false;
  if (!recipient && !caller.canWrite) throw new SurveyError(403, 'This survey was sent to someone else.');
  return { request, recipient };
}

/** What the form needs: the request, its questions, the rows and the answers so far. */
export async function openSurvey(id, caller, deps) {
  const { db } = defaults(deps);
  const { request, recipient } = await callerRequest(db, id, caller);
  if (recipient && !request.openedAt) await store.markOpened(db, request.id);
  const { contextAttributes, ...rest } = request;
  return {
    ...rest,
    contextValues: { description: request.contextDescription, ...(contextAttributes || {}) },
    rows: await loadRows(db, request.contextId, request.definition),
    asRecipient: recipient,
  };
}

function open(request) {
  if (request.status === 'submitted') throw new SurveyError(409, 'This survey has already been answered.');
  if (request.status === 'cancelled') throw new SurveyError(409, 'This survey was withdrawn.');
}

export async function saveDraft(id, answers, caller, deps) {
  const { db } = defaults(deps);
  const { request } = await callerRequest(db, id, caller);
  open(request);
  const rows = await loadRows(db, request.contextId, request.definition);
  const checked = checkAnswers(request.definition, answers, rowIdSets(rows));
  if (checked.errors.length) throw new SurveyError(400, 'Some answers have the wrong form.', { errors: checked.errors });
  await store.saveAnswers(db, request.id, checked.answers);
  return { answers: checked.answers };
}

/**
 * Submit: the answers must be complete; they become one interview (the
 * questions and answers as its transcript) and its claims, proposed by the
 * respondent, in one transaction with the request's new status.
 */
export async function submitSurvey(id, body = {}, caller, deps) {
  const { db } = defaults(deps);
  const { request: first, recipient } = await callerRequest(db, id, caller);
  open(first);
  const def = first.definition;
  const language = body.language && def.languages.includes(body.language) ? body.language : (first.language ?? def.languages[0]);
  const rows = await loadRows(db, first.contextId, def);
  const checked = checkAnswers(def, body.answers, rowIdSets(rows), { final: true });
  if (checked.errors.length) throw new SurveyError(400, 'Some answers are missing or have the wrong form.', { errors: checked.errors });

  const date = today();
  const respondent = { principalId: first.principalId, identityId: first.identityId, name: first.recipientName };
  const { transcript, claims } = buildResponse(def, checked.answers, {
    lang: language, contextName: first.contextName, respondent, date, rows,
    contextValues: { description: first.contextDescription, ...(first.contextAttributes || {}) },
  });

  return db.tx(async (client) => {
    const tdb = txDb(client);
    const request = await store.getRequest(tdb, first.id, { lock: true });
    open(request);
    const interview = await interviewStore.insertInterview(tdb, {
      contextId: request.contextId, principalId: request.principalId, identityId: request.identityId,
      intervieweeName: request.recipientName, interviewedAt: date, fileName: `${request.templateName} (survey)`,
      transcript, language, extractionStatus: 'done', createdBy: caller.user ?? null, surveyRequestId: request.id,
    });
    const claimIds = await interviewStore.insertClaims(tdb, { interviewId: interview.id, contextId: request.contextId, proposedBy: 'respondent' }, claims);
    await store.markSubmitted(tdb, request.id, { answers: checked.answers, interviewId: interview.id, user: caller.user, onBehalf: !recipient, language });
    return { interviewId: interview.id, claims: claimIds.length };
  });
}
