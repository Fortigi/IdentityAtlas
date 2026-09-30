// Natural-language reports (PROTOTYPE) — API routes.
//
// Every route needs the `customReports` feature (404 when off) and a permission,
// checked first (403). Documented in openapi.yaml under "Custom Reports".
//
// Analyst surface (data.write.reports):
//   GET    /api/nl-reports/catalog      entities, fields, operators, pickable columns
//   GET    /api/nl-reports/lookup       names for the compare reference picker (?entity=&q=)
//   GET    /api/nl-reports/status       is the report generator's model server reachable, which model
//   POST   /api/nl-reports/warm         load the configured model (call when the builder opens)
//   POST   /api/nl-reports/interpret    question (+ conversation) → definition or clarifying question
//   POST   /api/nl-reports/resolve      apply a "did you mean" answer, look named objects up again
//   POST   /api/nl-reports/run          definition → rows (read-only, statement timeout)
//   GET    /api/nl-reports/saved/:id    one saved report, for editing
//   POST   /api/nl-reports/saved        save a new report
//   PUT    /api/nl-reports/saved/:id    update a saved report
//   DELETE /api/nl-reports/saved/:id    delete a saved report
// Saved reports are listed and run through the regular /api/reports routes.
//
// Admin (admin.llm):
//   GET    /api/admin/nl-reports/config  configured model + models on the server
//   PUT    /api/admin/nl-reports/config  choose the model

import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { requireFeature } from '../featureFlags.js';
import { ENTITIES, OPERATORS, OPERATORS_BY_TYPE, fieldsOf } from '../nlreports/catalog.js';
import { availableColumns, groupableFields } from '../nlreports/spec.js';
import { loadExtFields } from '../nlreports/extFields.js';
import { applyResolveChoice, ensureWarm, interpret, loadValues, runSpec, warmupState } from '../nlreports/service.js';
import {
  completeRun, getConversation, listConversations, logConversation, newConversationId, OUTCOMES, SURFACES,
} from '../nlreports/conversations.js';
import { detectLanguage } from '../nlreports/language.js';
import { callerContextBlock, callerSubstitutions, resolveCaller } from '../nlreports/caller.js';
import { MODEL_IS_FIXED, listModels } from '../nlreports/llm.js';
import {
  CONVERSATION_ID, forLog, generatorStatus, oneQuestionAtATime, parseInterpretRequest, userOf, warmHandler,
} from '../nlreports/assistantHttp.js';

// Re-exported: the request shape is shared with the context assistant and lives with the
// other shared HTTP helpers now. Kept on this module so its own tests still import it here.
export { parseInterpretRequest };
import { getReportModel, setReportModel } from '../nlreports/settings.js';
import { MEASURES, manyRelationsOf } from '../nlreports/compare.js';
import { resolveNamedObjects, searchNames } from '../nlreports/references.js';
import { PREVIOUS_SENTINEL, validateSpec } from '../nlreports/spec.js';
import { carriedRecords, carryForward, narrowToPrevious, previousContextBlock, usedPrevious } from '../nlreports/followUp.js';
import { recallAnswer, rememberAnswer } from '../nlreports/state.js';
import { explainSpec } from '../nlreports/explain.js';
import { query } from '../db/connection.js';
import {
  createSavedReport, deleteSavedReport, getSavedReport, prepareSavedReport, updateSavedReport,
} from '../nlreports/savedReports.js';

const router = Router();

// Gates are applied per route, never on the /api mount: a mount-level gate runs
// for every later route too (it would 404 or 403 unrelated endpoints).
//
//   analyst — the caller may build reports AND the feature is on. Permission is
//             checked first, so a caller without it gets 403 whether or not the
//             feature is switched on (and never learns which installs have it). Building
//             saves definitions and spends the model CPU; running an existing
//             report is a read action served by /api/reports (data.read).
//   admin   — the feature must be on AND the caller administers the LLM.
// Asking is a READ action and gets its own gate. `data.read.reports` —
// "Ask questions in plain language" — was written for the Teams bot and says
// in as many words that it covers the bot "or anywhere else that only asks";
// the Ask page is that anywhere else. Keeping the two apart is the whole point
// of the split: a pilot manager should be able to ask a question without also
// being able to delete the saved reports every analyst sees.
//
// An analyst holds both (the seed RoleMiner role carries them), so nothing
// they could do before stops working.
const askGate = [requirePermission('data.read.reports'), requireFeature('customReports')];
const analystGate = [requirePermission('data.write.reports'), requireFeature('customReports')];
const adminGate = [requirePermission('admin.llm'), requireFeature('customReports')];

const claimQuestion = oneQuestionAtATime();
const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,100}$/;

function fail(res, route, err, status = 500) {
  console.error(`nl-reports ${route} failed:`, err.message);
  res.status(status).json({ error: status === 502 ? 'The local model server is not reachable or failed.' : 'Request failed' });
}


router.get('/nl-reports/catalog', askGate, async (req, res) => {
  try {
    const values = await loadValues();
    // This deployment's own extendedAttributes fields are part of the catalog the
    // builder offers: an attribute you can filter a list on is one you can build a
    // report on. `discovered` travels with them so the UI can keep them apart from
    // the fields every install has.
    const extFields = await loadExtFields();
    const entities = Object.fromEntries(Object.entries(ENTITIES).map(([name, e]) => [name, {
      label: e.label,
      table: e.table,
      description: e.description,
      compareRelations: manyRelationsOf(name),
      defaultColumns: e.defaultColumns,
      fields: Object.entries(fieldsOf(name, extFields)).map(([fname, f]) => ({
        name: fname, label: f.label, type: f.type,
        values: f.valuesFrom ? values[f.valuesFrom] || [] : undefined,
        discovered: f.discovered || undefined,
      })),
      relations: Object.entries(e.relations).map(([rname, r]) => ({ name: rname, label: r.label, target: r.target, cardinality: r.cardinality })),
      columns: availableColumns(name, extFields).map(({ key, label, discovered }) => ({ key, label, discovered })),
      groupableFields: groupableFields(name, extFields),
    }]));

    const operators = Object.fromEntries(Object.entries(OPERATORS).map(([k, o]) => [k, { label: o.label, needsValue: o.needsValue }]));
    const compareMeasures = Object.fromEntries(Object.entries(MEASURES).map(([k, m]) => [k, m.label]));
    res.json({ entities, operators, operatorsByType: OPERATORS_BY_TYPE, compareMeasures });
  } catch (err) {
    fail(res, 'catalog', err);
  }
});

// GET /api/nl-reports/lookup?entity=resource&q=mat — names for the compare reference picker
router.get('/nl-reports/lookup', askGate, async (req, res) => {
  const entity = String(req.query.entity || '');
  const text = String(req.query.q || '').trim();
  if (!Object.hasOwn(ENTITIES, entity)) return res.status(400).json({ error: 'Unknown entity' });
  if (text.length < 2 || text.length > 100) return res.json({ data: [] });
  try {
    res.json({ data: await searchNames(query, entity, text) });
  } catch (err) {
    fail(res, 'lookup', err);
  }
});

router.get('/nl-reports/status', askGate, async (req, res) => {
  res.json(await generatorStatus(warmupState));
});

router.post('/nl-reports/warm', analystGate, warmHandler({ ensureWarm, warmupState }, fail));

/**
 * Who is asking and what the previous answer in this chat left behind.
 *
 * Both are context the model needs and neither is HTTP: a signed-in user the
 * directory does not know — or no signed-in user at all — gets no caller, and
 * the builder then works exactly as it always did ("my" means nothing, and the
 * scope caveat says so). The carried records are what makes "these groups" mean
 * something; the model reliably gets the subject of a follow-up right and
 * reliably forgets to write the placeholder (see nlreports/followUp.js).
 */
async function askingContext(req, conversationId) {
  const caller = req.user?.oid ? await resolveCaller(req.user.oid).catch(() => null) : null;
  const carried = recallAnswer(threadKey(req, conversationId));
  const substitutions = callerSubstitutions(caller);
  if (carried?.records?.length) substitutions.set(PREVIOUS_SENTINEL, carried.records.map(r => r.id));
  return {
    caller,
    carried,
    substitutions,
    context: [caller ? callerContextBlock(caller) : '', previousContextBlock(carried)].filter(Boolean).join('\n\n'),
  };
}

/**
 * A report that turned out to be about the previous answer's records.
 *
 * Narrowing happens after the model has spoken, so it is applied to the reply
 * rather than to the question: the definition is replaced, its explanation
 * rebuilt from the narrowed one, and the reply says a follow-up was recognised
 * (either because it was narrowed, or because the model wrote the placeholder
 * itself). Mutates the reply, which is the object the handler is about to send.
 */
async function applyFollowUp(reply, carried, question) {
  if (reply.kind !== 'report' || !reply.spec) return reply;
  const narrowed = narrowToPrevious(reply.spec, carried, question);
  const narrowedIt = usedPrevious(reply.spec, narrowed);
  if (narrowedIt) {
    reply.spec = narrowed;
    reply.explanation = explainSpec(narrowed, await loadExtFields());
  }
  reply.followedUp = narrowedIt || (reply.substituted ?? []).includes(PREVIOUS_SENTINEL);
  return reply;
}

/** What the store keeps about a reply. A report is `interpreted` until /run says what it returned. */
const storedReply = (reply, model) => ({
  outcome: WEB_OUTCOME[reply.kind] ?? OUTCOMES.NOT_UNDERSTOOD,
  definition: reply.spec ?? null,
  clarification: askedBack(reply),
  error: reply.kind === 'error' ? reply.message : null,
  modelMs: reply.timing?.totalMs ?? reply.timing?.total ?? null,
  context: reply.context ?? null,
  rawReply: reply.raw ?? null,
  firstReply: reply.firstRaw ?? null,
  repaired: reply.repaired,
  model: reply.model ?? model,
});

router.post('/nl-reports/interpret', askGate, async (req, res) => {
  const parsed = parseInterpretRequest(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { question, history: cleanHistory, conversationId } = parsed;
  const started = Date.now();
  const who = claimQuestion(req, res);
  if (!who) return;
  const { caller, carried, substitutions, context } = await askingContext(req, conversationId);
  // Allocated up front: /run completes this row later, so the id has to exist
  // before anything is written.
  const logId = newConversationId();
  const record = (fields) => logConversation({
    id: logId,
    surface: SURFACES.WEB,
    callerOid: req.user?.oid ?? null,
    callerPrincipalId: caller?.principalId ?? null,
    conversationId,
    question,
    language: detectLanguage(question),
    totalMs: Date.now() - started,
    ...fields,
  });
  try {
    const model = req.body?.model ? String(req.body.model) : await getReportModel();
    // Audit trail: who asked what, with which model — logged on arrival, so a question
    // is on record even if the model never answers — and then what came back. The
    // question is analyst text. No rows or results are ever logged.
    // `caller=` last: the line's shape up to the question is a contract the
    // audit test pins, and a resolved caller is an addition to it, not a change.
    console.log(`nl-reports interpret: ${who} model=${forLog(model, 100)} question="${forLog(question)}" caller=${caller ? 'resolved' : '-'}`);
    const reply = await applyFollowUp(
      await interpret({ question, history: cleanHistory, model, context, substitutions, previousSpec: carried?.spec ?? null }),
      carried, question);
    console.log(`nl-reports interpret: ${who} outcome=${reply.kind}${reply.repaired ? ' repaired' : ''} ms=${Date.now() - started}`);
    // Its own line: whether the previous answer was offered and what became of
    // it — the line above is a contract the audit test pins.
    if (carried) console.log(`nl-reports follow-up: ${who} offered=${carried.records.length} used=${reply.followedUp === true}`);
    await record(storedReply(reply, model));
    res.json({ ...reply, logId });
  } catch (err) {
    console.log(`nl-reports interpret: ${who} outcome=failed ms=${Date.now() - started}`);
    await record({ outcome: OUTCOMES.FAILED, error: err.message });
    fail(res, 'interpret', err, 502);
  }
});

/** What each reply kind is filed as. Every value is one the CHECK constraint accepts. */
const WEB_OUTCOME = Object.freeze({
  report: OUTCOMES.INTERPRETED,
  clarify: OUTCOMES.CLARIFIED,
  confirm: OUTCOMES.CONFIRM,
  decline: OUTCOMES.DECLINED,
  error: OUTCOMES.NOT_UNDERSTOOD,
});

/** What the assistant said back instead of a report, for the store's clarification column. */
function askedBack(reply) {
  if (reply.kind === 'clarify') return reply.question;
  if (reply.kind === 'decline') return reply.reason;
  return reply.confirm?.message ?? null;
}

const LOG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What "these groups" refers to is remembered per chat, per signed-in user: a
// chat id is client-generated, so on its own it would let one caller's
// follow-up inherit another's answer.
const threadKey = (req, conversationId) => (conversationId ? `${req.user?.oid ?? '-'}:${conversationId}` : null);

// Re-exported: applying a "did you mean" answer is pipeline logic, not HTTP, and
// it now lives beside interpret()/runSpec() so a second front end (the Teams bot)
// can answer a confirmation without importing a route module. Kept on this module
// so its own tests still import it here.
export { applyResolveChoice };

// POST /api/nl-reports/resolve { spec, choice? } — apply the answer to a "did you mean"
// confirmation and look the named objects up again. No model involved.
router.post('/nl-reports/resolve', askGate, async (req, res) => {
  if (!req.body?.spec || typeof req.body.spec !== 'object') return res.status(400).json({ error: 'spec is required' });
  try {
    const values = await loadValues();
    const extFields = await loadExtFields();
    const { ok, spec: validated, errors } = validateSpec(req.body.spec, values, extFields);
    if (!ok) return res.status(400).json({ error: 'Invalid report definition', errors });
    const spec = applyResolveChoice(validated, req.body.choice, values, extFields);

    if (!spec) return res.status(400).json({ error: 'That choice does not match anything in the report' });
    const { confirm } = await resolveNamedObjects(spec, query);
    res.json({ spec, confirm, explanation: explainSpec(spec) });
  } catch (err) {
    fail(res, 'resolve', err);
  }
});

/**
 * The two optional ids a run may carry, checked before anything is run.
 *
 * `logId` is the row /interpret wrote, present when the caller is running that
 * same definition — the builder also runs edited definitions, which have no row
 * behind them. `conversationId` is the chat this answer belongs to, so the next
 * question in it can say "these". Both are client-supplied, so both are matched
 * against their pattern rather than trusted.
 *
 * @returns {{ error?: string, logId?: string|null, conversationId?: string|null }}
 */
function parseRunIds(body) {
  const logId = body.logId === undefined ? null : String(body.logId);
  if (logId !== null && !LOG_ID.test(logId)) return { error: 'Invalid log id' };
  const conversationId = body.conversationId === undefined || body.conversationId === null
    ? null : String(body.conversationId);
  if (conversationId !== null && !CONVERSATION_ID.test(conversationId)) return { error: 'Invalid conversation id' };
  return { logId, conversationId };
}

/**
 * What a successful run leaves behind: the records the next question may refer
 * to, and the completion of the row /interpret wrote.
 *
 * Both only happen after a successful run — a failed one put nothing in front of
 * the caller, so there is nothing to refer back to. completeRun is best-effort
 * and guarded inside: only the waiting row, for this caller, for exactly this
 * definition, so an edited-and-rerun report leaves the original question alone.
 */
async function rememberRun(req, { logId, conversationId }, result) {
  if (conversationId) {
    const key = threadKey(req, conversationId);
    const nowCarried = carryForward(recallAnswer(key), carriedRecords(result));
    if (nowCarried) rememberAnswer(key, nowCarried);
  }
  if (!logId) return;
  await completeRun({
    id: logId,
    callerOid: req.user?.oid ?? null,
    definition: result.spec,
    rowCount: result.rows.length,
    columns: result.columns.map(c => c.key),
    truncated: !!result.truncated,
    queryMs: result.elapsedMs ?? null,
  });
}

router.post('/nl-reports/run', askGate, async (req, res) => {
  if (!req.body?.spec || typeof req.body.spec !== 'object') return res.status(400).json({ error: 'spec is required' });
  const ids = parseRunIds(req.body);
  if (ids.error) return res.status(400).json({ error: ids.error });
  try {
    // "@me" in the definition means whoever runs it — see runSpec().
    const caller = req.user?.oid ? await resolveCaller(req.user.oid).catch(() => null) : null;
    const result = await runSpec(req.body.spec, callerSubstitutions(caller));
    if (!result.ok) return res.status(400).json({ error: 'Invalid report definition', errors: result.errors, confirm: result.confirm, spec: result.spec });
    await rememberRun(req, ids, result);
    res.json(result);
  } catch (err) {
    fail(res, 'run', err);
  }
});

// ── Saved reports ────────────────────────────────────────────────────────────

// GET /api/nl-reports/conversations — this person's earlier chats, newest first.
// Scoped to the signed-in caller inside the store; with nobody signed in there
// is nobody to list them for, and the answer is an empty list, not everyone's.
router.get('/nl-reports/conversations', askGate, async (req, res) => {
  try {
    const conversations = await listConversations(req.user?.oid ?? null, { limit: req.query.limit });
    res.json({ conversations });
  } catch (err) {
    fail(res, 'conversations', err);
  }
});

// GET /api/nl-reports/conversations/:id — the turns of one, for picking it up
// again. Unknown and not-yours are the same 404 on purpose: the id is a
// grouping key the client chose, not a secret, and the caller scope inside
// getConversation is what decides whose turns come back.
router.get('/nl-reports/conversations/:id', askGate, async (req, res) => {
  const id = String(req.params.id);
  if (!CONVERSATION_ID.test(id)) return res.status(400).json({ error: 'Invalid conversation id' });
  try {
    const turns = await getConversation(req.user?.oid ?? null, id);
    if (!turns.length) return res.status(404).json({ error: 'No such conversation' });
    res.json({ conversationId: id, turns });
  } catch (err) {
    fail(res, 'conversation', err);
  }
});

router.get('/nl-reports/saved/:id', askGate, async (req, res) => {
  try {
    const row = await getSavedReport(req.params.id);
    if (!row) return res.status(404).json({ error: 'Report not found' });
    res.json(row);
  } catch (err) {
    fail(res, 'get saved', err);
  }
});

async function saveReport(req, res, id) {
  try {
    const { errors, value } = await prepareSavedReport(req.body);
    if (errors) return res.status(400).json({ error: 'The report cannot be saved', errors });
    const row = id ? await updateSavedReport(id, value, userOf(req)) : await createSavedReport(value, userOf(req));
    if (!row) return res.status(404).json({ error: 'Report not found' });
    if (row.conflict) return res.status(409).json({ error: `A report named "${value.name}" already exists` });
    res.status(id ? 200 : 201).json(row);
  } catch (err) {
    fail(res, id ? 'update saved' : 'create saved', err);
  }
}

router.post('/nl-reports/saved', analystGate, (req, res) => saveReport(req, res, null));
router.put('/nl-reports/saved/:id', analystGate, (req, res) => saveReport(req, res, req.params.id));

router.delete('/nl-reports/saved/:id', analystGate, async (req, res) => {
  try {
    if (!(await deleteSavedReport(req.params.id))) return res.status(404).json({ error: 'Report not found' });
    res.json({ ok: true });
  } catch (err) {
    fail(res, 'delete saved', err);
  }
});

// ── Admin: which local model generates reports ───────────────────────────────

router.get('/admin/nl-reports/config', adminGate, async (req, res) => {
  try {
    const model = await getReportModel().catch(() => null);
    let models = [];
    let reachable = true;
    try { models = await listModels(); } catch { reachable = false; }
    res.json({ model, models, reachable, fixed: MODEL_IS_FIXED });
  } catch (err) {
    fail(res, 'admin config', err);
  }
});

router.put('/admin/nl-reports/config', adminGate, async (req, res) => {
  if (MODEL_IS_FIXED) return res.status(409).json({ error: 'The report generator model is fixed by this release' });
  const model = String(req.body?.model || '');
  if (!MODEL_NAME.test(model)) return res.status(400).json({ error: 'Invalid model name' });
  try {
    const models = await listModels();
    if (!models.some(m => m.name === model)) return res.status(400).json({ error: `Model "${model}" is not installed on the local model server` });
    await setReportModel(model);
    res.json({ ok: true, model });
  } catch (err) {
    fail(res, 'admin config save', err, 502);
  }
});

export default router;
