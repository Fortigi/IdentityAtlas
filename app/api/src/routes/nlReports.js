// Natural-language reports (PROTOTYPE) — API routes.
//
// Analyst surface (plain auth, like /api/reports):
//   GET    /api/nl-reports/catalog      entities, fields, operators, pickable columns
//   GET    /api/nl-reports/status       is the report generator's model server reachable, which model
//   POST   /api/nl-reports/warm         load the configured model (call when the builder opens)
//   POST   /api/nl-reports/interpret    question (+ conversation) → definition or clarifying question
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
import { ENTITIES, OPERATORS, OPERATORS_BY_TYPE } from '../nlreports/catalog.js';
import { availableColumns } from '../nlreports/spec.js';
import { interpret, loadValues, runSpec } from '../nlreports/service.js';
import { MODEL_IS_FIXED, listModels, warm } from '../nlreports/llm.js';
import { buildSystemPrompt } from '../nlreports/prompt.js';
import { getReportModel, setReportModel } from '../nlreports/settings.js';
import { MEASURES, manyRelationsOf } from '../nlreports/compare.js';
import { applyChoice, resolveNamedObjects, searchNames } from '../nlreports/references.js';
import { validateSpec } from '../nlreports/spec.js';
import { explainSpec } from '../nlreports/explain.js';
import { query } from '../db/connection.js';
import {
  createSavedReport, deleteSavedReport, getSavedReport, prepareSavedReport, updateSavedReport,
} from '../nlreports/savedReports.js';

const router = Router();
const adminGate = requirePermission('admin.llm');

const MAX_QUESTION = 2000;
const MAX_HISTORY = 12;
const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,100}$/;

function fail(res, route, err, status = 500) {
  console.error(`nl-reports ${route} failed:`, err.message);
  res.status(status).json({ error: status === 502 ? 'The local model server is not reachable or failed.' : 'Request failed' });
}

const userOf = (req) => (req.user && (req.user.email || req.user.upn || req.user.preferred_username || req.user.name)) || 'unknown';

router.get('/nl-reports/catalog', async (req, res) => {
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
router.get('/nl-reports/lookup', async (req, res) => {
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

router.get('/nl-reports/status', async (req, res) => {
  const model = await getReportModel().catch(() => null);
  try {
    const models = await listModels();
    const found = models.find(m => m.name === model);
    res.json({ available: !!found, model, loaded: !!found?.loaded, reason: found ? null : 'model-not-installed' });
  } catch {
    res.json({ available: false, model, loaded: false, reason: 'server-unreachable' });
  }
});

router.post('/nl-reports/warm', async (req, res) => {
  try {
    const model = await getReportModel();
    res.json(await warm(model, buildSystemPrompt(await loadValues())));
  } catch (err) {
    fail(res, 'warm', err, 502);
  }
});

router.post('/nl-reports/interpret', async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  if (!question || question.length > MAX_QUESTION) return res.status(400).json({ error: `Question is required (max ${MAX_QUESTION} characters)` });
  if (history.length > MAX_HISTORY) return res.status(400).json({ error: 'Conversation is too long — start a new question' });
  // `model` in the body is an evaluation override (tools/nl-reports/eval.mjs); the UI never sends it.
  if (req.body?.model !== undefined && !MODEL_NAME.test(String(req.body.model))) return res.status(400).json({ error: 'Invalid model name' });
  const cleanHistory = [];
  for (const h of history) {
    if (!h || !['user', 'assistant'].includes(h.role) || typeof h.content !== 'string' || h.content.length > 20000) {
      return res.status(400).json({ error: 'Invalid conversation history' });
    }
    cleanHistory.push({ role: h.role, content: h.content });
  }
  try {
    const model = req.body?.model ? String(req.body.model) : await getReportModel();
    // Audit trail: who asked what, with which model. The question is analyst text, not data.
    console.log(`nl-reports interpret: user=${userOf(req)} model=${model} question=${JSON.stringify(question.slice(0, 300))}`);
    res.json(await interpret({ question, history: cleanHistory, model }));
  } catch (err) {
    fail(res, 'interpret', err, 502);
  }
});

// POST /api/nl-reports/resolve { spec, choice? } — apply the answer to a "did you mean"
// confirmation and look the named objects up again. No model involved.
router.post('/nl-reports/resolve', async (req, res) => {
  if (!req.body?.spec || typeof req.body.spec !== 'object') return res.status(400).json({ error: 'spec is required' });
  try {
    const { ok, spec, errors } = validateSpec(req.body.spec, await loadValues());
    if (!ok) return res.status(400).json({ error: 'Invalid report definition', errors });
    if (req.body.choice && !applyChoice(spec, req.body.choice)) {
      return res.status(400).json({ error: 'That choice does not match anything in the report' });
    }
    const { confirm } = await resolveNamedObjects(spec, query);
    res.json({ spec, confirm, explanation: explainSpec(spec) });
  } catch (err) {
    fail(res, 'resolve', err);
  }
});

router.post('/nl-reports/run', async (req, res) => {
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

router.get('/nl-reports/saved/:id', async (req, res) => {
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

router.post('/nl-reports/saved', (req, res) => saveReport(req, res, null));
router.put('/nl-reports/saved/:id', (req, res) => saveReport(req, res, req.params.id));

router.delete('/nl-reports/saved/:id', async (req, res) => {
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
