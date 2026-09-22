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
import { ENTITIES, OPERATORS, OPERATORS_BY_TYPE } from '../nlreports/catalog.js';
import { availableColumns } from '../nlreports/spec.js';
import { applyResolveChoice, ensureWarm, interpret, loadValues, runSpec, warmupState } from '../nlreports/service.js';
import { MODEL_IS_FIXED, listModels } from '../nlreports/llm.js';
import {
  forLog, generatorStatus, oneQuestionAtATime, parseInterpretRequest, userOf, warmHandler,
} from '../nlreports/assistantHttp.js';

// Re-exported: the request shape is shared with the context assistant and lives with the
// other shared HTTP helpers now. Kept on this module so its own tests still import it here.
export { parseInterpretRequest };
import { getReportModel, setReportModel } from '../nlreports/settings.js';
import { MEASURES, manyRelationsOf } from '../nlreports/compare.js';
import { resolveNamedObjects, searchNames } from '../nlreports/references.js';
import { validateSpec } from '../nlreports/spec.js';
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
    const entities = Object.fromEntries(Object.entries(ENTITIES).map(([name, e]) => [name, {
      label: e.label,
      table: e.table,
      description: e.description,
      compareRelations: manyRelationsOf(name),
      defaultColumns: e.defaultColumns,
      fields: Object.entries(e.fields).map(([fname, f]) => ({
        name: fname, label: f.label, type: f.type,
        values: f.valuesFrom ? values[f.valuesFrom] || [] : undefined,
      })),
      relations: Object.entries(e.relations).map(([rname, r]) => ({ name: rname, label: r.label, target: r.target, cardinality: r.cardinality })),
      columns: availableColumns(name).map(({ key, label }) => ({ key, label })),
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

router.post('/nl-reports/interpret', askGate, async (req, res) => {
  const parsed = parseInterpretRequest(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { question, history: cleanHistory } = parsed;
  const started = Date.now();
  const who = claimQuestion(req, res);
  if (!who) return;
  try {
    const model = req.body?.model ? String(req.body.model) : await getReportModel();
    // Audit trail: who asked what, with which model — logged on arrival, so a question
    // is on record even if the model never answers — and then what came back. The
    // question is analyst text. No rows or results are ever logged.
    console.log(`nl-reports interpret: ${who} model=${forLog(model, 100)} question="${forLog(question)}"`);
    const reply = await interpret({ question, history: cleanHistory, model });
    console.log(`nl-reports interpret: ${who} outcome=${reply.kind}${reply.repaired ? ' repaired' : ''} ms=${Date.now() - started}`);
    res.json(reply);
  } catch (err) {
    console.log(`nl-reports interpret: ${who} outcome=failed ms=${Date.now() - started}`);
    fail(res, 'interpret', err, 502);
  }
});

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
    const { ok, spec: validated, errors } = validateSpec(req.body.spec, values);
    if (!ok) return res.status(400).json({ error: 'Invalid report definition', errors });
    const spec = applyResolveChoice(validated, req.body.choice, values);
    if (!spec) return res.status(400).json({ error: 'That choice does not match anything in the report' });
    const { confirm } = await resolveNamedObjects(spec, query);
    res.json({ spec, confirm, explanation: explainSpec(spec) });
  } catch (err) {
    fail(res, 'resolve', err);
  }
});

router.post('/nl-reports/run', askGate, async (req, res) => {
  if (!req.body?.spec || typeof req.body.spec !== 'object') return res.status(400).json({ error: 'spec is required' });
  try {
    const result = await runSpec(req.body.spec);
    if (!result.ok) return res.status(400).json({ error: 'Invalid report definition', errors: result.errors, confirm: result.confirm, spec: result.spec });
    res.json(result);
  } catch (err) {
    fail(res, 'run', err);
  }
});

// ── Saved reports ────────────────────────────────────────────────────────────

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
