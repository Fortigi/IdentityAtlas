// Pure logic for the SQL crawler wizard: no React, no component state. The
// wizard calls these and the unit tests exercise them directly, so a regression
// in a gate or in the saved shape is caught without rendering anything
// (tools/crawlers/CLAUDE.md → "Extract non-trivial logic into pure, exported
// functions").
import { presetQueries } from './sqlPresets.js';

// ─── Targets and slot constants (mirror crawler.json `queries[].*`) ──────────

// The six targets a statement's rows can become, with the one-line column
// contract the Queries step shows under the SQL. Full table: CLAUDE.md here.
export const TARGETS = [
  { id: 'identities',       label: 'Identities',       contract: 'id, displayName (+ email, givenName, surname, department, jobTitle, companyName, employeeId, principalType, enabled …)' },
  { id: 'principals',       label: 'Principals',       contract: 'id, displayName (+ identityId, email, givenName, surname, principalType, enabled …)' },
  { id: 'identity-members', label: 'Identity members', contract: 'identityId, principalId (+ isPrimary, accountType)' },
  { id: 'resources',        label: 'Resources',        contract: 'id, displayName (+ description, enabled); resourceType is the slot value' },
  { id: 'assignments',      label: 'Assignments',      contract: 'resourceId, principalId; resourceType, assignmentType and governed are the slot values' },
  { id: 'relationships',    label: 'Relationships',    contract: 'parentId, childId; relationshipType is the slot value' },
];
export const TARGET_IDS = TARGETS.map(t => t.id);
export const ASSIGNMENT_TYPES = ['Direct', 'Indirect', 'Eligible'];
export const RELATIONSHIP_TYPES = ['Contains', 'GrantsAccessTo'];
export const PRINCIPAL_TYPES = ['User', 'ServicePrincipal', 'ManagedIdentity', 'WorkloadIdentity', 'AIAgent', 'ExternalUser', 'SharedMailbox'];

// Which slot-level constants each target uses. A field a target does not use is
// left out of the saved slot entirely, so the crawler never sees a stray
// relationshipType on an assignments slot.
const SLOT_FIELDS_BY_TARGET = {
  identities: ['principalType'],
  principals: ['principalType'],
  'identity-members': [],
  resources: ['resourceType'],
  assignments: ['resourceType', 'assignmentType', 'governed'],
  relationships: ['relationshipType'],
};

export function slotFieldsFor(target) {
  return SLOT_FIELDS_BY_TARGET[target] || [];
}

// ─── Column contract (mirrors the table in CLAUDE.md → "Column contract") ────

// The contract columns each target recognises, split into the ones a row must
// carry and the ones it may. `columnMap` can only ever point AT one of these —
// anything else would land in extendedAttributes under its original name, which
// is what happens without a mapping anyway.
// The displayName fallbacks (`name`, `userId`) and the `enabled` inverses
// (`active` / `inactive` / `disabled`) are contract columns in their own right,
// so they are offered as mapping targets too.
const PERSON_OPTIONAL = [
  'name', 'userId', 'email', 'givenName', 'surname', 'department', 'jobTitle',
  'companyName', 'employeeId', 'principalType', 'enabled', 'active', 'inactive', 'disabled',
];

export const CONTRACT_COLUMNS = {
  identities:         { required: ['id', 'displayName'],             optional: PERSON_OPTIONAL },
  principals:         { required: ['id', 'displayName'],             optional: [...PERSON_OPTIONAL, 'identityId'] },
  'identity-members': { required: ['identityId', 'principalId'],     optional: ['isPrimary', 'accountType'] },
  resources:          { required: ['id', 'displayName'],             optional: ['name', 'description', 'enabled'] },
  // An identities row's account shares its id, so identityId is accepted where principalId is.
  assignments:        { required: ['resourceId', 'principalId'],     optional: ['identityId'] },
  relationships:      { required: ['parentId', 'childId'],           optional: [] },
};

const EMPTY_CONTRACT = { required: [], optional: [] };

// A stored target is request-supplied data, so an inherited name such as
// `constructor` must read as "no contract", not as Object's own property.
export function contractColumnsFor(target) {
  return Object.prototype.hasOwnProperty.call(CONTRACT_COLUMNS, target ?? '') ? CONTRACT_COLUMNS[target] : EMPTY_CONTRACT;
}

// Every contract column of a target, required ones first — the order the "Maps
// to" dropdown lists them in and the set validateColumnMap accepts.
export function contractColumnOptions(target) {
  const { required, optional } = contractColumnsFor(target);
  return [...required, ...optional];
}

// ─── Slot state ──────────────────────────────────────────────────────────────

const SLOT_DEFAULTS = { resourceType: '', assignmentType: 'Direct', governed: false, relationshipType: 'Contains', principalType: 'User' };

// A blank editor slot. Every field is bound (the editor switches which ones it
// shows when the target changes), so all of them get a default here.
export function newQuerySlot(target = 'identities') {
  return { name: '', target, sql: '', enabled: true, columnMap: [], ...SLOT_DEFAULTS };
}

// ─── Column mapping rows ─────────────────────────────────────────────────────
//
// crawler.json stores the mapping as an object (source column → contract
// column), which is the shape the crawler reads but an awkward one to edit: an
// object cannot hold a half-typed key, and renaming one re-keys it on every
// keystroke. The wizard therefore keeps an ordered array of { from, to } rows
// and converts on save (rowsToColumnMap) and on seed (columnMapToRows).

export function newColumnMapRow() {
  return { from: '', to: '' };
}

const trimmedRow = row => ({ from: (row?.from || '').trim(), to: (row?.to || '').trim() });

// Stored object → editor rows. A non-object (missing, null, an array) has no
// mapping to show, so the editor starts with no rows.
export function columnMapToRows(columnMap) {
  if (!columnMap || typeof columnMap !== 'object' || Array.isArray(columnMap)) return [];
  return Object.entries(columnMap).map(([from, to]) => ({ from, to: to == null ? '' : String(to) }));
}

// Editor rows → stored object. Blank and half-filled rows are dropped (the user
// is still typing, or added a row and thought better of it); a repeated source
// column keeps the last row, matching what the object form can hold.
export function rowsToColumnMap(rows) {
  const columnMap = {};
  for (const raw of Array.isArray(rows) ? rows : []) {
    const { from, to } = trimmedRow(raw);
    if (from && to) columnMap[from] = to;
  }
  return columnMap;
}

// A stored or preset slot only carries the fields its target uses; fill the rest
// with defaults so the editor has a value to bind. Keys the editor does not know
// are dropped. A missing `enabled` counts as enabled (crawler.json default).
export function toSlotState(raw) {
  const slot = newQuerySlot(raw?.target || 'identities');
  for (const key of Object.keys(slot)) {
    if (raw?.[key] !== undefined && raw[key] !== null) slot[key] = raw[key];
  }
  // The mapping is the one field whose stored shape differs from its editor
  // shape; re-seeding an editor slot (rows already) has to stay a no-op.
  slot.columnMap = Array.isArray(raw?.columnMap) ? raw.columnMap.map(trimmedRow) : columnMapToRows(raw?.columnMap);
  return slot;
}

// "Load example" appends the preset's slots after whatever is already there —
// on an empty list that is simply the preset. Nothing is ever overwritten, so
// the control needs no confirmation.
export function appendPresetSlots(queries, presetId) {
  return [...(queries || []), ...presetQueries(presetId).map(toSlotState)];
}

// ─── Wizard state seeding ────────────────────────────────────────────────────

// Every non-secret wizard field, seeded from a stored config on edit or from
// the crawler.json defaults on add. The password is not here: it is vaulted,
// never sent to the browser, and useCredentialFields keeps it blank.
export function seedWizardState(initialConfig) {
  const cfg = initialConfig || {};
  return {
    displayName: cfg.displayName || 'SQL Database',
    server: cfg.server || '',
    // The port input is text; a stored integer renders as its digits, a missing one as blank.
    port: String(cfg.port ?? ''),
    database: cfg.database || '',
    systemName: cfg.systemName || '',
    connection: {
      encrypt: cfg.encrypt !== false,
      trustServerCertificate: cfg.trustServerCertificate === true,
    },
    advanced: {
      connectTimeoutSeconds: cfg.connectTimeoutSeconds ?? 30,
      commandTimeoutSeconds: cfg.commandTimeoutSeconds ?? 600,
      batchSize:             cfg.batchSize ?? 5000,
      pageSize:              cfg.pageSize ?? 10000,
    },
    queries: (cfg.queries || []).map(toSlotState),
    schedules: cfg.schedules || [],
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const NEEDS_RESOURCE_TYPE = new Set(['resources', 'assignments']);
const blank = value => !(value || '').trim();

// One mapping row's problem, if it has one. `seen` carries the source columns
// already mapped, so the second row naming one reports as the duplicate.
function columnMapRowError(row, allowed, seen, target) {
  const { from, to } = row;
  if (!from && !to) return null;
  if (!from) return `map to "${to}" is missing the source column name`;
  if (!to) return `source column "${from}" is not mapped to anything`;
  if (!allowed.has(to)) return `"${to}" is not a ${target} column`;
  const key = from.toLowerCase();
  if (seen.has(key)) return `source column "${from}" is mapped twice`;
  seen.add(key);
  return null;
}

// A mapping is only meaningful against a target's contract, so changing a
// slot's target can invalidate rows that were fine a moment ago — that surfaces
// here rather than being silently dropped on save.
export function validateColumnMap(rows, target) {
  const allowed = new Set(contractColumnOptions(target));
  const seen = new Set();
  return (Array.isArray(rows) ? rows : [])
    .map(row => columnMapRowError(trimmedRow(row), allowed, seen, target))
    .filter(Boolean);
}

function validateSlot(slot, index) {
  const label = blank(slot.name) ? `Query ${index + 1}` : slot.name.trim();
  const errors = [];
  if (blank(slot.name)) errors.push(`${label}: name is required`);
  if (!TARGET_IDS.includes(slot.target)) errors.push(`${label}: unknown target "${slot.target ?? ''}"`);
  if (blank(slot.sql)) errors.push(`${label}: SQL is required`);
  if (NEEDS_RESOURCE_TYPE.has(slot.target) && blank(slot.resourceType)) errors.push(`${label}: resource type is required for ${slot.target}`);
  for (const error of validateColumnMap(slot.columnMap, slot.target)) errors.push(`${label}: ${error}`);
  return errors;
}

// Every slot is checked, disabled ones included: a disabled slot is still saved
// and crawler.json requires name, target and sql on each. On top of that at
// least one slot must be enabled, or the run would have nothing to do.
export function validateQueries(queries) {
  const list = Array.isArray(queries) ? queries : [];
  const errors = list.flatMap(validateSlot);
  if (!list.some(q => q.enabled !== false)) errors.unshift('At least one enabled query is required');
  return errors;
}

export function canSubmitQueries(queries) {
  return validateQueries(queries).length === 0;
}

// The port is optional (blank = driver default / SQL Browser for a named
// instance); when given it must be a TCP port.
export function parsePort(port) {
  const n = parseInt(port, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export function isValidPort(port) {
  return String(port ?? '').trim() === '' || parsePort(port) !== null;
}

// ─── Saved config ────────────────────────────────────────────────────────────

const toInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isInteger(n) ? n : fallback;
};

const SLOT_FIELD_VALUES = {
  resourceType:     s => (s.resourceType || '').trim(),
  assignmentType:   s => s.assignmentType || 'Direct',
  governed:         s => s.governed === true,
  relationshipType: s => s.relationshipType || 'Contains',
  principalType:    s => s.principalType || 'User',
};

// One editor slot → one crawler.json `queries[]` entry: trimmed, typed, and
// carrying only the slot fields its target uses.
export function buildQuerySlot(slot) {
  const out = { name: (slot.name || '').trim(), target: slot.target, sql: (slot.sql || '').trim(), enabled: slot.enabled !== false };
  for (const field of slotFieldsFor(slot.target)) out[field] = SLOT_FIELD_VALUES[field](slot);
  // An empty mapping is omitted rather than saved as {}: the columns already
  // match the contract, which is the normal case and the shape the crawler
  // treats as "no mapping".
  const columnMap = rowsToColumnMap(slot.columnMap);
  if (Object.keys(columnMap).length > 0) out.columnMap = columnMap;
  return out;
}

// The config blob in the crawler.json shape. Credentials are NOT here — the
// wizard merges buildCredentialFields('BasicAuth', creds) so a blank password
// keeps the vaulted value on edit.
export function buildSqlConfigPayload({
  server = '', port, database = '', encrypt, trustServerCertificate,
  connectTimeoutSeconds, commandTimeoutSeconds, batchSize, pageSize,
  systemName, queries = [], schedules,
}) {
  const config = {
    server: server.trim(),
    database: database.trim(),
    encrypt: encrypt !== false,
    trustServerCertificate: trustServerCertificate === true,
    connectTimeoutSeconds: toInt(connectTimeoutSeconds, 30),
    commandTimeoutSeconds: toInt(commandTimeoutSeconds, 600),
    batchSize: toInt(batchSize, 5000),
    pageSize: toInt(pageSize, 10000),
    queries: queries.map(buildQuerySlot),
  };
  const portNumber = parsePort(port);
  if (portNumber !== null) config.port = portNumber;
  // System name is an OVERRIDE: a blank field omits the key so the run names
  // the system after the crawler (Get-CrawlerSystemName).
  if (systemName && systemName.trim()) config.systemName = systemName.trim();
  if (schedules && schedules.length) config.schedules = schedules;
  return config;
}
