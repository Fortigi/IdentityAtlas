// Context activity — let the local model refine the heuristic guess, when there is one.
//
//   refineActivityGuess({ fileName, profile, guess, hasChildren }) → { mapping, aiUsed, aiFields }
//
// The list upload's refinement (upload/aiRefine.js), with this mapping's prompt
// and schema: the same model (NL_REPORTS_LLM_URL), the same 12-second budget,
// the same column summary. Each field the model answers is taken only when the
// mapping still checks clean with it (mapping.js); anything slow, failing or
// unparseable leaves the guess untouched. Never throws, never writes — the
// analyst confirms the mapping (decision principle B3).

import { aiConfigured, askModel, withTimeout, AI_TIMEOUT_MS } from '../upload/aiRefine.js';
import { checkActivityMapping } from './mapping.js';
import { UNITS } from './guess.js';

const FIELDS = ['contextColumn', 'subjectNameColumn', 'subjectEmailColumn', 'dateColumn', 'amountColumn', 'unit', 'kindColumn'];
const nullableString = { type: ['string', 'null'] };

export const ACTIVITY_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['dateColumn'],
  properties: {
    contextColumn: nullableString,
    subjectNameColumn: nullableString,
    subjectEmailColumn: nullableString,
    dateColumn: { type: 'string' },
    amountColumn: nullableString,
    unit: { type: 'string', enum: UNITS },
    kindColumn: nullableString,
  },
});

const SYSTEM_PROMPT = `You map the columns of an activity export an analyst uploads to Identity Atlas, an identity governance tool: a time registration (hours per person per customer or project) or an audit log (who did what, when). Each row is one piece of activity by one person. Reply with JSON only.
- contextColumn: the column naming the customer, project, team or site the row is about, or null.
- subjectNameColumn: the person's name, or null. subjectEmailColumn: the person's e-mail address or user name, or null. At least one of the two.
- dateColumn: the date of the activity (a start date, not an end date).
- amountColumn: the hours or duration of the row, or null when each row is one event. unit: "hours" for a duration, "events" for a count.
- kindColumn: what kind of activity (a task, an operation), or null.
Use only the column names given, spelled exactly.`;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Merge a model reply over the guess, one field at a time. A field is taken
 * only when it adds no problem the mapping did not already have (the guess may
 * itself be incomplete — a file without a recognisable date — and the model
 * may be the one to fill that in). The unit column is the model's only when the
 * guess found none: the guess chose it by matching the file's values against
 * the tree, which the model cannot see. Pure.
 */
export function mergeActivityReply(guess, reply, columns, { hasChildren = false } = {}) {
  let merged = { ...guess };
  let problems = checkActivityMapping(merged, columns, { hasChildren }).errors;
  const aiFields = [];
  for (const field of FIELDS) {
    if (!reply || !(field in reply) || same(merged[field], reply[field])) continue;
    // A unit column the guess chose by its values (it names units of the tree) stands.
    if (field === 'contextColumn' && guess.contextColumn) continue;
    const { mapping, errors } = checkActivityMapping({ ...merged, [field]: reply[field] }, columns, { hasChildren });
    if (!errors.every(e => problems.includes(e))) continue;
    merged = mapping;
    problems = errors;
    aiFields.push(field);
  }
  return { mapping: merged, aiFields };
}

export async function refineActivityGuess({ fileName, profile, guess, hasChildren = false }, {
  timeoutMs = AI_TIMEOUT_MS, enabled = aiConfigured, ask = askModel,
} = {}) {
  const unchanged = { mapping: guess, aiUsed: false, aiFields: [] };
  if (!enabled()) return unchanged;
  try {
    const reply = await withTimeout(ask(fileName, profile, { systemPrompt: SYSTEM_PROMPT, schema: ACTIVITY_RESPONSE_SCHEMA }), timeoutMs);
    const { mapping, aiFields } = mergeActivityReply(guess, reply, profile.map(c => c.name), { hasChildren });
    return { mapping, aiUsed: true, aiFields };
  } catch (err) {
    console.warn('Activity upload: the model did not refine the guess —', String(err?.message ?? err).slice(0, 200));
    return unchanged;
  }
}
