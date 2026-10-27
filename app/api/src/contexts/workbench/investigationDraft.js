// Authorization workbench — the shape of a saved investigation (M2a), checked.
// Design: docs/architecture/m1-discovery-and-design.md, "M2a — save and reopen".
//
// What the browser sends when an analyst saves:
//   { name, description, view, accessReadAt, accessCells, marks, candidate }
//     view         the workbench view (columns, filters, sort, …) — kept as given, only known keys
//     accessReadAt when the access data on screen was read (the workbench's generatedAt)
//     accessCells  the held cells on screen then: "personKey|resourceId|type"
//     marks        [{ person, resourceId, mark, note }]
//     proposals    [{ id, name, description, baseBusinessRoleId, members, entitlements, evidenceClaimIds,
//                    kind, rule, excluded, joinerPolicy, leaverPolicy, approver, rationale }]
//                  — every proposed role of the investigation; one left out is removed
// A person is the workbench's row key: "i:<identity id>" or "p:<account id>".
//
// Pure: no database. Never trusts a column name, a size or a value it was sent.

export const MARKS = Object.freeze(['other', 'unrelated', 'investigate']);
// How a proposed role is assigned (migration 108).
export const ASSIGNMENT_KINDS = Object.freeze(['rule', 'requestable']);
export const JOINER_POLICIES = Object.freeze(['auto', 'approval']);
export const LEAVER_POLICIES = Object.freeze(['remove', 'review', 'keep']);
export const MEMBER_KINDS = Object.freeze(['member', 'exclude']);
export const APPROVER_KINDS = Object.freeze(['accountable', 'owner', 'person']);
export const MAX_RATIONALE = 2000;
export const MAX_RULE_BYTES = 16 * 1024;
export const ACCESS_TYPES = Object.freeze(['Direct', 'Indirect', 'Eligible']);
export const MAX_NAME = 200;
export const MAX_DESCRIPTION = 1000;
export const MAX_NOTE = 1000;
// 400 people × 300 columns is the most the workbench shows (load.js).
export const MAX_CELLS = 120000;
export const MAX_VIEW_BYTES = 64 * 1024;
const VIEW_KEYS = ['columns', 'filters', 'sort', 'includeChildren', 'minHolders', 'columnSearch', 'groupBy'];

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSON_RE = /^([ip]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// The type alternatives are ACCESS_TYPES (the test holds the two together).
const CELL_RE = /^[ip]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|(Direct|Indirect|Eligible)$/i;

export class InvestigationError extends Error {
  constructor(status, message) { super(message); this.name = 'InvestigationError'; this.status = status; }
}

const bad = (message) => { throw new InvestigationError(400, message); };

/** "i:<id>" → { personKind: 'identity', personId }, "p:<id>" → principal; null when not a person key. */
export function parsePerson(key) {
  const m = typeof key === 'string' ? PERSON_RE.exec(key) : null;
  if (!m) return null;
  return { personKind: m[1].toLowerCase() === 'i' ? 'identity' : 'principal', personId: m[2].toLowerCase() };
}

/** The workbench's row key of a stored person. */
export const personKeyOf = (personKind, personId) => `${personKind === 'identity' ? 'i' : 'p'}:${personId}`;

function text(value, max, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') bad(`${label} must be text.`);
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

/** The name an investigation is saved under; required. */
export function parseName(value) {
  const name = text(value, MAX_NAME, 'The name');
  if (!name) bad('Give the investigation a name.');
  return name;
}

function list(value, label, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad(`${label} must be a list.`);
  if (value.length > max) bad(`${label}: at most ${max}.`);
  return value;
}

/** Only the view keys the workbench has; refused when it is not an object or too large. */
export function parseView(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) bad('The view must be an object.');
  const view = Object.fromEntries(VIEW_KEYS.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
  if (JSON.stringify(view).length > MAX_VIEW_BYTES) bad('The view is too large to save.');
  return view;
}

export function parseReadAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(t)) bad('accessReadAt must be a date.');
  return new Date(t).toISOString();
}

/** The held cells on screen, lower-cased and without duplicates. */
export function parseCells(value) {
  const cells = list(value, 'accessCells', MAX_CELLS);
  for (const c of cells) if (typeof c !== 'string' || !CELL_RE.test(c)) bad('accessCells holds a cell that is not "person|resource|type".');
  return [...new Set(cells.map(c => {
    const [p, r, type] = c.split('|');
    return `${p.toLowerCase()}|${r.toLowerCase()}|${ACCESS_TYPES.find(t => t.toLowerCase() === type.toLowerCase())}`;
  }))];
}

function parseMark(m) {
  const person = parsePerson(m?.person);
  if (!person) bad('A mark names a person that is not a workbench row.');
  if (typeof m.resourceId !== 'string' || !UUID_RE.test(m.resourceId)) bad('A mark names a resource that is not an id.');
  if (!MARKS.includes(m.mark)) bad(`A mark must be one of: ${MARKS.join(', ')}.`);
  return { ...person, resourceId: m.resourceId.toLowerCase(), mark: m.mark, note: text(m.note, MAX_NOTE, 'A note') };
}

/** One mark per cell: a later mark on the same cell replaces an earlier one. */
export function parseMarks(value) {
  const byCell = new Map();
  for (const raw of list(value, 'marks', MAX_CELLS)) {
    const m = parseMark(raw);
    byCell.set(`${m.personKind}|${m.personId}|${m.resourceId}`, m);
  }
  return [...byCell.values()];
}

function ids(value, label, max) {
  const out = list(value, label, max);
  for (const id of out) if (typeof id !== 'string' || !UUID_RE.test(id)) bad(`${label} holds something that is not an id.`);
  return [...new Set(out.map(id => id.toLowerCase()))];
}

function people(value, label = 'members') {
  const seen = new Map();
  for (const key of list(value, label, MAX_CELLS)) {
    const p = parsePerson(key);
    if (!p) bad('The candidate names a member that is not a workbench row.');
    seen.set(`${p.personKind}|${p.personId}`, p);
  }
  return [...seen.values()];
}

const oneOf = (value, allowed, label, fallback) => {
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value)) bad(`${label} must be one of: ${allowed.join(', ')}.`);
  return value;
};

// The rule: { includeChildren, filters: { <column>: { values: [...], includeProposed, contains: [...] } } }.
// Kept as given (the browser reads it), only its known keys, refused when too large.
function parseRule(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) bad('The rule must be an object.');
  const filters = value.filters && typeof value.filters === 'object' && !Array.isArray(value.filters) ? value.filters : {};
  const rule = { includeChildren: value.includeChildren !== false, filters };
  if (JSON.stringify(rule).length > MAX_RULE_BYTES) bad('The rule is too large to save.');
  return rule;
}

function parseApprover(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) bad('The approver must be an object.');
  const kind = oneOf(value.kind, APPROVER_KINDS, 'The approver', null);
  const principalId = kind === 'person' && value.principalId ? ids([value.principalId], 'The approver', 1)[0] : null;
  return { kind, principalId, name: text(value.name, MAX_NAME, 'The approver name') };
}

/** How the role is assigned: its kind, rule, exceptions, joiner/leaver policies, approver, rationale. */
function parseAssignment(value) {
  return {
    kind: oneOf(value.kind, ASSIGNMENT_KINDS, 'The kind', null),
    rule: parseRule(value.rule),
    excluded: people(value.excluded, 'excluded'),
    joinerPolicy: oneOf(value.joinerPolicy, JOINER_POLICIES, 'The joiner policy', 'auto'),
    leaverPolicy: oneOf(value.leaverPolicy, LEAVER_POLICIES, 'The leaver policy', 'remove'),
    approver: parseApprover(value.approver),
    rationale: text(value.rationale, MAX_RATIONALE, 'The rationale'),
  };
}

/**
 * One proposed role: { id, name, description, baseBusinessRoleId, members,
 * entitlements, evidenceClaimIds } and how it is assigned (parseAssignment). `id` is optional (the browser may name a new
 * draft itself); a proposal that starts from an existing business role is an
 * extension of it, otherwise a new role.
 */
export function parseProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad('A proposed role must be an object.');
  const base = value.baseBusinessRoleId ?? value.baseRoleId;
  const baseBusinessRoleId = base ? ids([base], 'baseBusinessRoleId', 1)[0] : null;
  return {
    // The browser's own handle for an unsaved draft ("draft:3") is not an id: such a
    // proposal is new, and the save answers with the id it got.
    id: typeof value.id === 'string' && UUID_RE.test(value.id) ? value.id.toLowerCase() : null,
    mode: baseBusinessRoleId ? 'extend' : 'new',
    baseBusinessRoleId,
    name: text(value.name, MAX_NAME, 'The proposal name') ?? '',
    description: text(value.description, MAX_DESCRIPTION, 'The proposal description'),
    members: people(value.members),
    entitlements: ids(value.entitlements, 'entitlements', MAX_CELLS),
    evidenceClaimIds: ids(value.evidenceClaimIds, 'evidenceClaimIds', MAX_CELLS),
    ...parseAssignment(value),
  };
}

export const MAX_PROPOSALS = 50;

/**
 * The proposed roles of the investigation, in the order shown. A save holds all
 * of them: one left out is removed. `candidate` (a single one) is still read
 * for a browser that sends only the panel's draft. Two with the same id: refused.
 */
export function parseProposals(src) {
  const raw = src.proposals !== undefined ? list(src.proposals, 'proposals', MAX_PROPOSALS)
    : (src.candidate ? [src.candidate] : []);
  const proposals = raw.map(parseProposal);
  const named = proposals.map(p => p.id).filter(Boolean);
  if (new Set(named).size !== named.length) bad('Two proposed roles have the same id.');
  return proposals;
}

/**
 * The whole saved draft. `requireName`: a new investigation needs one; an update
 * keeps its name unless it sends another.
 */
export function parseDraft(body, { requireName }) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const hasName = src.name !== undefined && src.name !== null;
  return {
    name: requireName || hasName ? parseName(src.name) : undefined,
    description: src.description === undefined ? undefined : text(src.description, MAX_DESCRIPTION, 'The description'),
    view: parseView(src.view),
    accessReadAt: parseReadAt(src.accessReadAt),
    accessCells: parseCells(src.accessCells),
    marks: parseMarks(src.marks),
    proposals: parseProposals(src),
    expectedUpdatedAt: src.expectedUpdatedAt ? parseReadAt(src.expectedUpdatedAt) : null,
  };
}
