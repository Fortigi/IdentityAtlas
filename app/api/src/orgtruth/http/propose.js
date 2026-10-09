// Organisation truth — the model's proposal (owned by workstream T3).
//
//   GET  /api/org-truth/propose/status   (data.read)            is the report generator configured and
//        reachable, is this prompt warm:
//        { configured, available, model, loaded, promptCache, reason }
//   POST /api/org-truth/propose/recipe   (data.write.contexts)  { fileName?, columns, rowCount? }
//        → { recipe, linkRules, notes: string[], origin: 'model' | 'heuristic',
//            timing: { ms, model: boolean, rounds?, llm? } }
//        `columns` is the column profile of import/profileColumns.js:
//          [{ name, index?, nonEmpty, distinct, uniqueness, shape, samples: string[] }]
//        `recipe` and `linkRules` are already validated and normalised (contracts.js).
//
// Works without a model: the heuristic proposal (column names and value shapes) is the
// fallback, and the wizard lets the analyst edit either.
//
// DECISION (until T1's import engine lands): the body carries the profile itself. A
// `{ sourceId }` body answers 501 for now; the integrator wires it to T1's stored-source
// parse + profile and keeps the `{ fileName, columns }` path, which the wizard can use
// after a client-side profile too.
import { Router } from 'express';
import { READ_GATE, WRITE_GATE } from './gates.js';
import { forLog, generatorStatus, oneQuestionAtATime } from '../../nlreports/assistantHttp.js';
import { propose, warmupState } from '../propose/service.js';
import { probeColumns, loadProbeTargets, findCompositeKey } from '../propose/probe.js';
import { getSourceWithContent, readSourceTable } from '../import/sourceStore.js';
import { profileColumns } from '../import/profileColumns.js';

const router = Router();
const claim = oneQuestionAtATime();

export const MAX_COLUMNS = 500;
const SHAPES = ['email', 'number', 'date', 'boolean', 'text'];
const MAX_NAME = 256;
const count = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

function cleanColumn(c, i) {
  if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name.trim() || c.name.length > MAX_NAME) return null;
  return {
    name: c.name,
    index: Number.isInteger(c.index) ? c.index : i,
    nonEmpty: count(c.nonEmpty),
    distinct: count(c.distinct),
    uniqueness: Math.min(1, count(c.uniqueness)),
    shape: SHAPES.includes(c.shape) ? c.shape : 'text',
    samples: (Array.isArray(c.samples) ? c.samples : []).slice(0, 5).map(s => String(s ?? '').slice(0, 200)),
  };
}

/**
 * Check a proposal request.
 * @returns {{ error: string, status?: number } | { fileName: string, columns: object[], rowCount?: number }}
 */
export function parseProposeRequest(body) {
  if (body?.sourceId !== undefined && body?.columns === undefined) return { sourceOnly: true, sourceId: body.sourceId };
  const columns = Array.isArray(body?.columns) ? body.columns : null;
  if (!columns || columns.length === 0 || columns.length > MAX_COLUMNS) return { error: `columns must be a list of 1 to ${MAX_COLUMNS} column profiles` };
  const clean = columns.map(cleanColumn);
  if (clean.some(c => c === null)) return { error: `Every column needs a name of at most ${MAX_NAME} characters` };
  const fileName = typeof body.fileName === 'string' ? body.fileName.slice(0, MAX_NAME) : '';
  const rowCount = Number.isInteger(body.rowCount) && body.rowCount >= 0 ? body.rowCount : undefined;
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId : undefined;
  return { fileName, columns: clean, ...(rowCount === undefined ? {} : { rowCount }), ...(sourceId ? { sourceId } : {}) };
}

// With a stored source: its rows are read, every column's values probed against
// the accounts, resources and other lists, and a composite key looked for, so
// the proposal follows the data (probe.js). Without one: the profile alone.
async function withProbes(parsed) {
  if (!parsed.sourceId) return parsed;
  const source = await getSourceWithContent(parsed.sourceId);
  if (!source) return { notFound: true };
  const table = await readSourceTable(source);
  const columns = parsed.columns ?? profileColumns(table.columns, table.rows);
  const probes = probeColumns(columns, table.rows, await loadProbeTargets());
  const hasKey = columns.some(c => c.uniqueness >= 0.8 && ['text', 'number'].includes(c.shape));
  return {
    fileName: parsed.fileName || source.fileName || source.displayName || '',
    columns, rowCount: table.rows.length, probes,
    compositeKey: hasKey ? null : findCompositeKey(columns, table.rows),
  };
}

router.get('/org-truth/propose/status', READ_GATE, async (_req, res) => {
  if (!process.env.NL_REPORTS_LLM_URL) {
    return res.json({ configured: false, available: false, model: null, loaded: false, promptCache: warmupState(), reason: 'not-configured' });
  }
  res.json({ configured: true, ...(await generatorStatus(warmupState)) });
});

router.post('/org-truth/propose/recipe', WRITE_GATE, async (req, res) => {
  const parsed = parseProposeRequest(req.body);
  if (parsed.error) return res.status(parsed.status ?? 400).json({ error: parsed.error });
  if (parsed.sourceOnly) parsed.columns = undefined;
  const who = claim(req, res);
  if (!who) return;
  try {
    const input = await withProbes(parsed);
    if (input.notFound) return res.status(404).json({ error: 'Source not found.' });
    const result = await propose(input);
    console.log(`org-truth propose: ${who} file="${forLog(input.fileName, 120)}" columns=${input.columns.length} origin=${result.origin} ms=${result.timing.ms}`);
    res.json(result);
  } catch (err) {
    console.error('org-truth propose failed:', err.message);
    res.status(500).json({ error: 'Request failed' });
  }
});

export default router;
