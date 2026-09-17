// Context assistant — API routes.
//
// Every route needs the `contextAssistant` feature (404 when off) and the
// `data.write.contexts` permission, checked first (403). Documented in openapi.yaml
// under "Context Assistant".
//
//   GET  /api/context-assistant/options          resource types and searchable fields
//   GET  /api/context-assistant/status           is the report generator reachable
//   POST /api/context-assistant/warm             load the model, restore this prompt's cache
//   POST /api/context-assistant/interpret        description (+ conversation) → terms or a question
//   POST /api/context-assistant/suggest          description + kept/dropped terms → new terms
//   POST /api/context-assistant/evaluate         recipe → per-term numbers and the matched objects
//   POST /api/context-assistant/related          recipe → words typical of what it finds (no model)
//   GET  /api/context-assistant/lookup           objects by name, to include one by hand (?q=)
//   GET  /api/context-assistant/recipe/:id       the recipe behind a context tree, to edit it
//   POST /api/context-assistant/save             create the context tree, or refresh an existing one
//
// Only interpret, suggest and warm use the model. Everything else works without the
// report generator: an analyst can type the terms themselves.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requirePermission } from '../middleware/auth.js';
import { requireFeature } from '../featureFlags.js';
import { query, queryOne, tx } from '../db/connection.js';
import { forLog, generatorStatus, oneQuestionAtATime, userOf, warmResponse } from '../nlreports/assistantHttp.js';
import { searchNames } from '../nlreports/references.js';
import { loadValues } from '../nlreports/service.js';
import { parseInterpretRequest } from './nlReports.js';
import { ensureWarm, interpret, suggestMore, warmupState } from '../contextAssistant/service.js';
import { SEARCH_FIELDS, searchFieldLabel, validateRecipe } from '../contexts/recipe/recipe.js';
import { computeMatches, loadCandidates } from '../contexts/recipe/matches.js';
import { loadScopeNames, relatedWords } from '../contexts/recipe/relatedWords.js';
import { enqueueRun, getRun } from '../contexts/plugins/runner.js';

const router = Router();

// Per route, never on the mount (a mount-level gate would apply to every later /api route).
const gate = [requirePermission('data.write.contexts'), requireFeature('contextAssistant')];

const PLUGIN = 'context-recipe';
const MAX_QUESTION = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const claimQuestion = oneQuestionAtATime();

function fail(res, route, err, status = 500) {
  console.error(`context-assistant ${route} failed:`, err.message);
  res.status(status).json({ error: status === 502 ? 'The local model server is not reachable or failed.' : 'Request failed' });
}

const bodyRecipe = (req) => (req.body?.recipe && typeof req.body.recipe === 'object' ? req.body.recipe : null);

router.get('/context-assistant/options', gate, async (req, res) => {
  try {
    const values = await loadValues();
    res.json({
      resourceTypes: values.resourceType || [],
      fields: SEARCH_FIELDS.map(name => ({ name, label: searchFieldLabel(name) })),
    });
  } catch (err) {
    fail(res, 'options', err);
  }
});

router.get('/context-assistant/status', gate, async (req, res) => {
  res.json(await generatorStatus(warmupState));
});

router.post('/context-assistant/warm', gate, async (req, res) => {
  try {
    const answer = await warmResponse({ ensureWarm, warmupState });
    if (!answer) return fail(res, 'warm', new Error('the model server did not answer'), 502);
    res.json(answer);
  } catch (err) {
    fail(res, 'warm', err, 502);
  }
});

// Runs one model request for an analyst, with the audit line custom reports also writes:
// who asked what (logged on arrival), then the outcome. Never the model's reply.
async function askModel(req, res, route, question, work) {
  const who = claimQuestion(req, res);
  if (!who) return;
  const started = Date.now();
  console.log(`context-assistant ${route}: ${who} question="${forLog(question)}"`);
  try {
    const reply = await work();
    console.log(`context-assistant ${route}: ${who} outcome=${reply.kind} ms=${Date.now() - started}`);
    res.json(reply);
  } catch (err) {
    console.log(`context-assistant ${route}: ${who} outcome=failed ms=${Date.now() - started}`);
    fail(res, route, err, 502);
  }
}

router.post('/context-assistant/interpret', gate, async (req, res) => {
  const parsed = parseInterpretRequest(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  await askModel(req, res, 'interpret', parsed.question, () => interpret(parsed));
});

router.post('/context-assistant/suggest', gate, async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (!question || question.length > MAX_QUESTION) return res.status(400).json({ error: `Question is required (max ${MAX_QUESTION} characters)` });
  const raw = bodyRecipe(req);
  if (!raw) return res.status(400).json({ error: 'recipe is required' });
  const { recipe } = validateRecipe(raw);
  await askModel(req, res, 'suggest', question, () => suggestMore({ question, recipe }));
});

router.post('/context-assistant/evaluate', gate, async (req, res) => {
  const raw = bodyRecipe(req);
  if (!raw) return res.status(400).json({ error: 'recipe is required' });
  const { recipe, errors } = validateRecipe(raw);
  try {
    const { rows, scopeTotal, truncated } = await loadCandidates(recipe, tx);
    const { terms, matches, memberIds } = computeMatches(rows, recipe, scopeTotal);
    res.json({ recipe, errors, scopeTotal, truncated, terms, matches, memberCount: memberIds.length });
  } catch (err) {
    fail(res, 'evaluate', err);
  }
});

router.post('/context-assistant/related', gate, async (req, res) => {
  const raw = bodyRecipe(req);
  if (!raw) return res.status(400).json({ error: 'recipe is required' });
  const { recipe } = validateRecipe(raw);
  try {
    const { rows, scopeTotal } = await loadCandidates(recipe, tx);
    const { memberIds } = computeMatches(rows, recipe, scopeTotal);
    const words = relatedWords(await loadScopeNames(recipe, tx), memberIds, recipe);
    res.json({ data: words, contextSize: memberIds.length });
  } catch (err) {
    fail(res, 'related', err);
  }
});

router.get('/context-assistant/lookup', gate, async (req, res) => {
  const text = String(req.query.q || '').trim();
  if (text.length < 2 || text.length > 100) return res.json({ data: [] });
  try {
    res.json({ data: await searchNames(query, 'resource', text) });
  } catch (err) {
    fail(res, 'lookup', err);
  }
});

/** The root context of a tree built from a recipe, with its run parameters. */
async function recipeTree(contextId) {
  return queryOne(`
    SELECT c."id", c."displayName", c."sourceInstanceKey", r."parameters"
      FROM "Contexts" c
      JOIN "ContextAlgorithms" a ON a."id" = c."sourceAlgorithmId"
      LEFT JOIN "ContextAlgorithmRuns" r ON r."id" = c."sourceRunId"
     WHERE c."id" = $1 AND a."name" = $2 AND c."parentContextId" IS NULL AND c."variant" = 'generated'`,
  [contextId, PLUGIN]);
}

router.get('/context-assistant/recipe/:id', gate, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Context not found' });
  try {
    const row = await recipeTree(req.params.id);
    if (!row) return res.status(404).json({ error: 'This context was not built with the context assistant' });
    const params = row.parameters || {};
    res.json({
      contextId: row.id,
      recipe: validateRecipe(params.recipe).recipe,
      question: typeof params.question === 'string' ? params.question : '',
    });
  } catch (err) {
    fail(res, 'recipe', err);
  }
});

async function instanceKeyFor(contextId) {
  if (!contextId) return { key: randomUUID() };
  if (!UUID_RE.test(String(contextId))) return { error: 'Context not found' };
  const row = await recipeTree(contextId);
  if (!row?.sourceInstanceKey) return { error: 'Context not found' };
  return { key: row.sourceInstanceKey };
}

// Creates the tree, or refreshes an existing one in place (keeping renames and
// re-parenting), by running the plugin now — a recipe run is one query, so the answer
// can wait for it and hand back the context to open.
router.post('/context-assistant/save', gate, async (req, res) => {
  const raw = bodyRecipe(req);
  if (!raw) return res.status(400).json({ error: 'recipe is required' });
  const { ok, recipe, errors } = validateRecipe(raw);
  if (!recipe.name) errors.unshift('Give the context a name.');
  if (!ok || !recipe.name) return res.status(400).json({ error: 'The context cannot be saved', errors });
  const question = typeof req.body.question === 'string' ? req.body.question.trim().slice(0, MAX_QUESTION) : '';
  try {
    const target = await instanceKeyFor(req.body.contextId);
    if (target.error) return res.status(404).json({ error: target.error });
    const runId = await enqueueRun(PLUGIN, { recipe, question, instanceKey: target.key }, userOf(req), { awaitCompletion: true });
    const run = await getRun(runId);
    if (run?.status !== 'succeeded') {
      return res.status(500).json({ error: 'Building the context failed', detail: run?.errorMessage || null, runId });
    }
    const root = await queryOne(
      `SELECT "id" FROM "Contexts" WHERE "sourceInstanceKey" = $1 AND "parentContextId" IS NULL AND "variant" = 'generated' LIMIT 1`,
      [target.key]);
    res.status(req.body.contextId ? 200 : 201).json({ runId, contextId: root?.id || null, membersAdded: run.membersAdded, membersRemoved: run.membersRemoved });
  } catch (err) {
    fail(res, 'save', err);
  }
});

export default router;
