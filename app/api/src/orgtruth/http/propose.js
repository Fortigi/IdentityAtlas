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
  if (body?.sourceId !== undefined && body?.columns === undefined) {
    return { status: 501, error: 'Proposing from a stored source is not built yet; send fileName and columns.' };
  }
  const columns = Array.isArray(body?.columns) ? body.columns : null;
  if (!columns || columns.length === 0 || columns.length > MAX_COLUMNS) return { error: `columns must be a list of 1 to ${MAX_COLUMNS} column profiles` };
  const clean = columns.map(cleanColumn);
  if (clean.some(c => c === null)) return { error: `Every column needs a name of at most ${MAX_NAME} characters` };
  const fileName = typeof body.fileName === 'string' ? body.fileName.slice(0, MAX_NAME) : '';
  const rowCount = Number.isInteger(body.rowCount) && body.rowCount >= 0 ? body.rowCount : undefined;
  return { fileName, columns: clean, ...(rowCount === undefined ? {} : { rowCount }) };
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
  const who = claim(req, res);
  if (!who) return;
  try {
    const result = await propose(parsed);
    console.log(`org-truth propose: ${who} file="${forLog(parsed.fileName, 120)}" columns=${parsed.columns.length} origin=${result.origin} ms=${result.timing.ms}`);
    res.json(result);
  } catch (err) {
    console.error('org-truth propose failed:', err.message);
    res.status(500).json({ error: 'Request failed' });
  }
});

export default router;
