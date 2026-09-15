// Natural-language reports (PROTOTYPE) — API routes.
//
// GET  /api/nl-reports/catalog    entities, fields, operators, pickable columns
// GET  /api/nl-reports/models     models available on the local LLM server
// POST /api/nl-reports/warm       load a model into memory (call when the page opens)
// POST /api/nl-reports/interpret  question (+ conversation) → spec or clarifying question
// POST /api/nl-reports/run        spec → rows (read-only, statement timeout)

import { Router } from 'express';
import { ENTITIES, OPERATORS, OPERATORS_BY_TYPE } from '../nlreports/catalog.js';
import { availableColumns } from '../nlreports/spec.js';
import { interpret, loadValues, runSpec } from '../nlreports/service.js';
import { DEFAULT_MODEL, listModels, warm } from '../nlreports/ollama.js';
import { buildSystemPrompt } from '../nlreports/prompt.js';

const router = Router();

const MAX_QUESTION = 2000;
const MAX_HISTORY = 12;
const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,100}$/;

function fail(res, route, err, status = 500) {
  console.error(`nl-reports ${route} failed:`, err.message);
  res.status(status).json({ error: status === 502 ? 'The local model server is not reachable or failed.' : 'Request failed' });
}

router.get('/nl-reports/catalog', async (req, res) => {
  try {
    const values = await loadValues();
    const entities = Object.fromEntries(Object.entries(ENTITIES).map(([name, e]) => [name, {
      label: e.label,
      description: e.description,
      defaultColumns: e.defaultColumns,
      fields: Object.entries(e.fields).map(([fname, f]) => ({
        name: fname, label: f.label, type: f.type,
        values: f.valuesFrom ? values[f.valuesFrom] || [] : undefined,
      })),
      relations: Object.entries(e.relations).map(([rname, r]) => ({ name: rname, label: r.label, target: r.target, cardinality: r.cardinality })),
      columns: availableColumns(name).map(({ key, label }) => ({ key, label })),
    }]));
    const operators = Object.fromEntries(Object.entries(OPERATORS).map(([k, o]) => [k, { label: o.label, needsValue: o.needsValue }]));
    res.json({ entities, operators, operatorsByType: OPERATORS_BY_TYPE });
  } catch (err) {
    fail(res, 'catalog', err);
  }
});

router.get('/nl-reports/models', async (req, res) => {
  try {
    res.json({ models: await listModels(), defaultModel: DEFAULT_MODEL });
  } catch (err) {
    fail(res, 'models', err, 502);
  }
});

router.post('/nl-reports/warm', async (req, res) => {
  const model = String(req.body?.model || DEFAULT_MODEL);
  if (!MODEL_NAME.test(model)) return res.status(400).json({ error: 'Invalid model name' });
  try {
    res.json(await warm(model, buildSystemPrompt(await loadValues())));
  } catch (err) {
    fail(res, 'warm', err, 502);
  }
});

router.post('/nl-reports/interpret', async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  const model = String(req.body?.model || DEFAULT_MODEL);
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  if (!question || question.length > MAX_QUESTION) return res.status(400).json({ error: `Question is required (max ${MAX_QUESTION} characters)` });
  if (!MODEL_NAME.test(model)) return res.status(400).json({ error: 'Invalid model name' });
  if (history.length > MAX_HISTORY) return res.status(400).json({ error: 'Conversation is too long — start a new question' });
  const cleanHistory = [];
  for (const h of history) {
    if (!h || !['user', 'assistant'].includes(h.role) || typeof h.content !== 'string' || h.content.length > 20000) {
      return res.status(400).json({ error: 'Invalid conversation history' });
    }
    cleanHistory.push({ role: h.role, content: h.content });
  }
  // Audit trail: who asked what, with which model. The question is analyst text, not data.
  console.log(`nl-reports interpret: user=${req.user?.preferred_username || req.user?.oid || 'anonymous'} model=${model} question=${JSON.stringify(question.slice(0, 300))}`);
  try {
    res.json(await interpret({ question, history: cleanHistory, model }));
  } catch (err) {
    fail(res, 'interpret', err, 502);
  }
});

router.post('/nl-reports/run', async (req, res) => {
  if (!req.body?.spec || typeof req.body.spec !== 'object') return res.status(400).json({ error: 'spec is required' });
  try {
    const result = await runSpec(req.body.spec);
    if (!result.ok) return res.status(400).json({ error: 'Invalid report definition', errors: result.errors });
    res.json(result);
  } catch (err) {
    fail(res, 'run', err);
  }
});

export default router;
