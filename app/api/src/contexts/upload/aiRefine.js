// Context upload — let the local model refine the heuristic guess, when there is one.
//
//   refineGuess({ fileName, profile, guess }) → { mapping, aiUsed, aiFields }
//
// OPTIONAL by design. The heuristic guess (guess.js) is always complete; the
// model — the report generator's (nlreports/llm.js), configured by
// NL_REPORTS_LLM_URL — is asked only when that is set, with a hard time budget.
// Its answer is checked field by field against the file's columns and the closed
// lists (mapping.js); a field it got wrong keeps the heuristic's value. A slow,
// failing or unparseable answer returns the guess untouched with aiUsed false.
// It never throws and never writes: what the analyst confirms is what is applied
// (decision principle B3). `aiFields` names the fields the model changed, so the
// wizard can mark them.

import { chat } from '../../nlreports/llm.js';
import { getReportModel } from '../../nlreports/settings.js';
import { checkMapping } from './mapping.js';
import { MEMBER_KINDS, TEMPLATES } from './guess.js';

export const AI_TIMEOUT_MS = 12_000;
const MAX_COLUMNS_IN_PROMPT = 40;
const SINGLE_FIELDS = ['template', 'listName', 'nameColumn', 'keyColumn', 'ownerColumn', 'responsibleColumn', 'parentColumn'];

const nullableString = { type: ['string', 'null'] };
export const RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['template', 'listName', 'nameColumn', 'keyColumn', 'memberColumns'],
  properties: {
    template: { type: 'string', enum: TEMPLATES },
    listName: { type: 'string', maxLength: 80 },
    nameColumn: { type: 'string' },
    keyColumn: { type: 'string' },
    ownerColumn: nullableString,
    responsibleColumn: nullableString,
    parentColumn: nullableString,
    memberColumns: {
      type: 'array', maxItems: 4,
      items: { type: 'object', required: ['column', 'kind'], properties: { column: { type: 'string' }, kind: { type: 'string', enum: MEMBER_KINDS } } },
    },
  },
});

export const aiConfigured = () => !!process.env.NL_REPORTS_LLM_URL;

const SYSTEM_PROMPT = `You map the columns of a spreadsheet an analyst uploads to Identity Atlas, an identity governance tool. Each row becomes one context: an organisation unit (a customer, a department, a team) or an application. Reply with JSON only.
- template: "OrganizationalUnit" or "LogicalApplication".
- listName: a short plural name for the list.
- nameColumn: the column that names the row. keyColumn: a column whose value is unique per row (an id or code), else the name column.
- ownerColumn: the person accountable (owner, eigenaar, manager), or null. responsibleColumn: other people who answer for it, or null. parentColumn: the column naming a parent row, or null.
- memberColumns: columns listing who or what belongs to the row. kind "Principal" for accounts or e-mail addresses of users, "Identity" for people, "Resource" for groups, applications or roles. At most two kinds.
Use only the column names given, spelled exactly.`;

const clip = (v, n) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** The user message: file name and one line per column (shape, counts, three samples). */
export function buildUserMessage(fileName, profile) {
  const lines = profile.slice(0, MAX_COLUMNS_IN_PROMPT).map(c =>
    `- ${JSON.stringify(clip(c.name, 80))} | ${c.shape} | filled ${c.nonEmpty} | distinct ${c.distinct} | several per cell ${c.multiValued > 0 ? 'yes' : 'no'} | samples: ${c.samples.slice(0, 3).map(s => JSON.stringify(clip(s, 40))).join(', ')}`);
  return [`File: ${JSON.stringify(clip(fileName || '(unnamed)', 120))}`, 'Columns:', ...lines].join('\n');
}

export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function askModel(fileName, profile) {
  const model = await getReportModel().catch(() => undefined);
  const { content } = await chat({
    model,
    schema: RESPONSE_SCHEMA,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserMessage(fileName, profile) }],
  });
  return JSON.parse(content);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Merge a model reply over the guess, one field at a time: a field is taken only
 * when, put into the guess on its own, the mapping still checks clean.
 * Attribute columns are then every column no role claims. Pure.
 */
export function mergeReply(guess, reply, columns) {
  const merged = { ...guess };
  const aiFields = [];
  const take = (field, value) => {
    const candidate = { ...merged, [field]: value };
    if (checkMapping(candidate, columns).errors.length === 0 && !same(merged[field], value)) {
      merged[field] = checkMapping(candidate, columns).mapping[field];
      aiFields.push(field);
    }
  };
  for (const field of SINGLE_FIELDS) if (reply && field in reply) take(field, reply[field]);
  if (Array.isArray(reply?.memberColumns)) {
    take('memberColumns', reply.memberColumns.map(m => ({ ...m, shape: guess.memberColumns.find(g => g.column === m?.column)?.shape ?? 'list' })));
  }
  const used = new Set([merged.nameColumn, merged.keyColumn, merged.ownerColumn, merged.responsibleColumn, merged.parentColumn,
    ...merged.memberColumns.map(m => m.column)]);
  merged.attributeColumns = columns.filter(c => !used.has(c));
  return { mapping: merged, aiFields };
}

export async function refineGuess({ fileName, profile, guess }, { timeoutMs = AI_TIMEOUT_MS, enabled = aiConfigured, ask = askModel } = {}) {
  const unchanged = { mapping: guess, aiUsed: false, aiFields: [] };
  if (!enabled()) return unchanged;
  try {
    const reply = await withTimeout(ask(fileName, profile), timeoutMs);
    const { mapping, aiFields } = mergeReply(guess, reply, profile.map(c => c.name));
    return { mapping, aiUsed: true, aiFields };
  } catch (err) {
    console.warn('Context upload: the model did not refine the guess —', String(err?.message ?? err).slice(0, 200));
    return unchanged;
  }
}
