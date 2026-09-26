/**
 * Unit tests for the SQL wizard's extracted pure logic — slot defaults, the
 * per-target slot fields, the Queries-step gate, and the saved-config builder.
 * These are the branches a render smoke test can't reach (no handlers fire) and
 * where a silent regression would let an unrunnable query set through to save
 * or drop a slot constant the crawler reconciles on. Runs under the UI's vitest.
 */
import { describe, it, expect } from 'vitest';
import {
  TARGET_IDS, newQuerySlot, toSlotState, appendPresetSlots, slotFieldsFor, seedWizardState,
  validateQueries, canSubmitQueries, parsePort, isValidPort, buildQuerySlot, buildSqlConfigPayload,
  CONTRACT_COLUMNS, contractColumnsFor, contractColumnOptions,
  newColumnMapRow, columnMapToRows, rowsToColumnMap, validateColumnMap,
} from './wizardLogic.js';
import { IDENTITYIQ_PRESET } from './sqlPresets.js';

const slot = (over = {}) => ({ ...newQuerySlot(), name: 'Q', sql: 'SELECT 1', ...over });

describe('newQuerySlot', () => {
  it('defaults to an enabled identities slot with every slot constant bound', () => {
    expect(newQuerySlot()).toEqual({
      name: '', target: 'identities', sql: '', enabled: true, columnMap: [],
      resourceType: '', assignmentType: 'Direct', governed: false, relationshipType: 'Contains', principalType: 'User',
    });
  });

  it('takes the target it is given', () => {
    expect(newQuerySlot('assignments').target).toBe('assignments');
  });
});

describe('slotFieldsFor', () => {
  it('lists exactly the crawler.json slot constants each target uses', () => {
    expect(slotFieldsFor('identities')).toEqual(['principalType']);
    expect(slotFieldsFor('principals')).toEqual(['principalType']);
    expect(slotFieldsFor('identity-members')).toEqual([]);
    expect(slotFieldsFor('resources')).toEqual(['resourceType']);
    expect(slotFieldsFor('assignments')).toEqual(['resourceType', 'assignmentType', 'governed']);
    expect(slotFieldsFor('relationships')).toEqual(['relationshipType']);
  });

  it('covers every target and returns nothing for an unknown one', () => {
    for (const t of TARGET_IDS) expect(Array.isArray(slotFieldsFor(t))).toBe(true);
    expect(slotFieldsFor('groups')).toEqual([]);
    expect(slotFieldsFor(undefined)).toEqual([]);
  });
});

describe('toSlotState', () => {
  it('fills the fields a stored slot does not carry with defaults', () => {
    const s = toSlotState({ name: 'Roles', target: 'resources', sql: 'SELECT 1', resourceType: 'BusinessRole' });
    expect(s).toMatchObject({ name: 'Roles', target: 'resources', resourceType: 'BusinessRole', enabled: true, assignmentType: 'Direct', governed: false, relationshipType: 'Contains', principalType: 'User' });
  });

  it('keeps a stored enabled=false and governed=true', () => {
    const s = toSlotState({ name: 'X', target: 'assignments', sql: 's', enabled: false, governed: true });
    expect(s.enabled).toBe(false);
    expect(s.governed).toBe(true);
  });

  it('drops keys the editor does not know and treats null as unset', () => {
    const s = toSlotState({ name: 'X', target: 'identities', sql: 's', foo: 1, principalType: null });
    expect(s).not.toHaveProperty('foo');
    expect(s.principalType).toBe('User');
  });

  it('survives a missing input', () => {
    expect(toSlotState(undefined)).toEqual(newQuerySlot());
  });
});

describe('appendPresetSlots', () => {
  it('loads the preset into an empty list', () => {
    const out = appendPresetSlots([], 'identityiq');
    expect(out).toHaveLength(IDENTITYIQ_PRESET.length);
    expect(out[0]).toMatchObject({ name: 'Identities', target: 'identities', enabled: true, resourceType: '' });
    expect(out[4]).toMatchObject({ name: 'Role assignments', target: 'assignments', resourceType: 'BusinessRole', governed: true });
  });

  it('appends after existing slots without touching them', () => {
    const existing = [slot({ name: 'Mine' })];
    const out = appendPresetSlots(existing, 'identityiq');
    expect(out).toHaveLength(1 + IDENTITYIQ_PRESET.length);
    expect(out[0]).toBe(existing[0]);
    expect(existing).toHaveLength(1);
  });

  it('adds nothing for an unknown preset', () => {
    expect(appendPresetSlots([slot()], 'nope')).toHaveLength(1);
    expect(appendPresetSlots(undefined, 'nope')).toEqual([]);
  });

  it('every preset slot passes validation as loaded', () => {
    expect(validateQueries(appendPresetSlots([], 'identityiq'))).toEqual([]);
  });
});

describe('seedWizardState', () => {
  it('add mode starts from the crawler.json defaults with no queries or schedules', () => {
    expect(seedWizardState(null)).toEqual({
      displayName: 'SQL Database', server: '', port: '', database: '', systemName: '',
      connection: { encrypt: true, trustServerCertificate: false },
      advanced: { connectTimeoutSeconds: 30, commandTimeoutSeconds: 600, batchSize: 5000, pageSize: 10000 },
      queries: [], schedules: [],
    });
    expect(seedWizardState(undefined)).toEqual(seedWizardState({}));
  });

  it('edit mode seeds every non-secret field from the stored config', () => {
    const schedules = [{ enabled: true, syncMode: 'full', frequency: 'daily', hour: 2, minute: 0 }];
    const seed = seedWizardState({
      id: 7, displayName: 'IIQ prod', server: 'sql01', port: 1533, database: 'iiq', systemName: 'IdentityIQ',
      encrypt: false, trustServerCertificate: true,
      connectTimeoutSeconds: 45, commandTimeoutSeconds: 0, batchSize: 250, pageSize: 500,
      username: 'ia_reader', password: 'never-here',
      queries: [{ name: 'R', target: 'resources', sql: 's', resourceType: 'Entitlement' }],
      schedules,
    });
    expect(seed).toEqual({
      displayName: 'IIQ prod', server: 'sql01', port: '1533', database: 'iiq', systemName: 'IdentityIQ',
      connection: { encrypt: false, trustServerCertificate: true },
      advanced: { connectTimeoutSeconds: 45, commandTimeoutSeconds: 0, batchSize: 250, pageSize: 500 },
      queries: [{ ...newQuerySlot('resources'), name: 'R', sql: 's', resourceType: 'Entitlement' }],
      schedules,
    });
    expect(seed).not.toHaveProperty('password');
    expect(seed).not.toHaveProperty('username');
  });

  it('keeps a stored 0 command timeout rather than replacing it with the default', () => {
    expect(seedWizardState({ commandTimeoutSeconds: 0 }).advanced.commandTimeoutSeconds).toBe(0);
  });

  it('treats a missing encrypt as on and a missing trustServerCertificate as off', () => {
    expect(seedWizardState({ server: 'h' }).connection).toEqual({ encrypt: true, trustServerCertificate: false });
  });
});

describe('validateQueries / canSubmitQueries', () => {
  it('accepts one enabled slot with name, target and SQL', () => {
    expect(validateQueries([slot()])).toEqual([]);
    expect(canSubmitQueries([slot()])).toBe(true);
  });

  it('rejects an empty or missing list', () => {
    expect(validateQueries([])).toEqual(['At least one enabled query is required']);
    expect(canSubmitQueries(undefined)).toBe(false);
  });

  it('rejects a list whose only slots are disabled', () => {
    expect(canSubmitQueries([slot({ enabled: false }), slot({ enabled: false })])).toBe(false);
    expect(canSubmitQueries([slot({ enabled: false }), slot()])).toBe(true);
  });

  it('names the slot that is missing a name, SQL or target', () => {
    expect(validateQueries([slot({ name: '  ' })])).toEqual(['Query 1: name is required']);
    expect(validateQueries([slot({ name: 'Users', sql: ' ' })])).toEqual(['Users: SQL is required']);
    expect(validateQueries([slot({ name: 'Users', target: 'groups' })])).toEqual(['Users: unknown target "groups"']);
    expect(validateQueries([slot({ name: 'Users', target: undefined })])).toEqual(['Users: unknown target ""']);
  });

  it('requires a resource type on resources and assignments slots only', () => {
    expect(validateQueries([slot({ name: 'R', target: 'resources' })])).toEqual(['R: resource type is required for resources']);
    expect(validateQueries([slot({ name: 'A', target: 'assignments', resourceType: '  ' })])).toEqual(['A: resource type is required for assignments']);
    expect(validateQueries([slot({ target: 'resources', resourceType: 'Entitlement' })])).toEqual([]);
    expect(validateQueries([slot({ target: 'relationships' })])).toEqual([]);
    expect(validateQueries([slot({ target: 'identity-members' })])).toEqual([]);
  });

  it('still validates a disabled slot, because it is saved and the schema requires its fields', () => {
    expect(validateQueries([slot(), slot({ name: '', enabled: false })])).toEqual(['Query 2: name is required']);
  });

  it('collects every error across slots, in slot order', () => {
    const errors = validateQueries([slot({ name: '', sql: '' }), slot({ name: 'B', target: 'resources' })]);
    expect(errors).toEqual(['Query 1: name is required', 'Query 1: SQL is required', 'B: resource type is required for resources']);
  });
});

describe('parsePort / isValidPort', () => {
  it('parses a numeric string and a number', () => {
    expect(parsePort('1433')).toBe(1433);
    expect(parsePort(1533)).toBe(1533);
  });

  it('rejects out-of-range, non-numeric and blank values', () => {
    expect(parsePort('0')).toBeNull();
    expect(parsePort('65536')).toBeNull();
    expect(parsePort('70000')).toBeNull();
    expect(parsePort('abc')).toBeNull();
    expect(parsePort('')).toBeNull();
    expect(parsePort(undefined)).toBeNull();
  });

  it('treats blank as valid (default port) but a bad value as invalid', () => {
    expect(isValidPort('')).toBe(true);
    expect(isValidPort('  ')).toBe(true);
    expect(isValidPort(undefined)).toBe(true);
    expect(isValidPort('1433')).toBe(true);
    expect(isValidPort('70000')).toBe(false);
    expect(isValidPort('x')).toBe(false);
  });
});

describe('buildQuerySlot', () => {
  it('trims name and SQL and keeps enabled as a boolean', () => {
    expect(buildQuerySlot(slot({ name: ' Users ', sql: '\nSELECT 1\n' }))).toMatchObject({ name: 'Users', sql: 'SELECT 1', enabled: true });
    expect(buildQuerySlot(slot({ enabled: false })).enabled).toBe(false);
    expect(buildQuerySlot({ name: 'x', target: 'identities', sql: 's' }).enabled).toBe(true);
  });

  it('an assignments slot carries resourceType, assignmentType and governed — and no relationshipType or principalType', () => {
    const out = buildQuerySlot(slot({ target: 'assignments', resourceType: ' BusinessRole ', assignmentType: 'Indirect', governed: true }));
    expect(out).toEqual({ name: 'Q', target: 'assignments', sql: 'SELECT 1', enabled: true, resourceType: 'BusinessRole', assignmentType: 'Indirect', governed: true });
  });

  it('a relationships slot carries only relationshipType', () => {
    const out = buildQuerySlot(slot({ target: 'relationships', relationshipType: 'GrantsAccessTo', resourceType: 'X', governed: true }));
    expect(out).toEqual({ name: 'Q', target: 'relationships', sql: 'SELECT 1', enabled: true, relationshipType: 'GrantsAccessTo' });
  });

  it('an identities / principals slot carries only principalType; identity-members carries nothing extra', () => {
    expect(buildQuerySlot(slot({ principalType: 'ServicePrincipal' }))).toEqual({ name: 'Q', target: 'identities', sql: 'SELECT 1', enabled: true, principalType: 'ServicePrincipal' });
    expect(buildQuerySlot(slot({ target: 'principals' })).principalType).toBe('User');
    expect(buildQuerySlot(slot({ target: 'identity-members' }))).toEqual({ name: 'Q', target: 'identity-members', sql: 'SELECT 1', enabled: true });
  });

  it('a resources slot carries only resourceType', () => {
    expect(buildQuerySlot(slot({ target: 'resources', resourceType: 'Entitlement' }))).toEqual({ name: 'Q', target: 'resources', sql: 'SELECT 1', enabled: true, resourceType: 'Entitlement' });
  });

  it('falls back to the crawler.json defaults for a blank enum and writes governed as a strict boolean', () => {
    const out = buildQuerySlot({ name: 'A', target: 'assignments', sql: 's', resourceType: 'E', assignmentType: '', governed: 'yes' });
    expect(out.assignmentType).toBe('Direct');
    expect(out.governed).toBe(false);
    expect(buildQuerySlot({ name: 'R', target: 'relationships', sql: 's' }).relationshipType).toBe('Contains');
  });
});

describe('buildSqlConfigPayload', () => {
  const base = {
    server: ' sql01.corp.local ', port: '', database: ' identityiq ',
    encrypt: true, trustServerCertificate: false,
    connectTimeoutSeconds: '30', commandTimeoutSeconds: '600', batchSize: '5000', pageSize: '10000',
    systemName: '', queries: [slot({ name: 'Users' })], schedules: [],
  };

  it('produces the crawler.json shape with trimmed strings and typed numbers', () => {
    expect(buildSqlConfigPayload(base)).toEqual({
      server: 'sql01.corp.local', database: 'identityiq', encrypt: true, trustServerCertificate: false,
      connectTimeoutSeconds: 30, commandTimeoutSeconds: 600, batchSize: 5000, pageSize: 10000,
      queries: [{ name: 'Users', target: 'identities', sql: 'SELECT 1', enabled: true, principalType: 'User' }],
    });
  });

  it("omits port when blank and writes '1433' as the integer 1433", () => {
    expect(buildSqlConfigPayload(base)).not.toHaveProperty('port');
    expect(buildSqlConfigPayload({ ...base, port: '1433' }).port).toBe(1433);
    expect(buildSqlConfigPayload({ ...base, port: 1533 }).port).toBe(1533);
  });

  it('writes both connection flags as strict booleans (an unset encrypt means on)', () => {
    const on = buildSqlConfigPayload({ ...base, encrypt: undefined, trustServerCertificate: 'yes' });
    expect(on.encrypt).toBe(true);
    expect(on.trustServerCertificate).toBe(false);
    const off = buildSqlConfigPayload({ ...base, encrypt: false, trustServerCertificate: true });
    expect(off.encrypt).toBe(false);
    expect(off.trustServerCertificate).toBe(true);
  });

  it('falls back to the schema defaults for a blank or non-numeric number, but keeps an explicit 0 command timeout', () => {
    const out = buildSqlConfigPayload({ ...base, connectTimeoutSeconds: '', commandTimeoutSeconds: '0', batchSize: 'abc', pageSize: undefined });
    expect(out).toMatchObject({ connectTimeoutSeconds: 30, commandTimeoutSeconds: 0, batchSize: 5000, pageSize: 10000 });
    expect(buildSqlConfigPayload({ ...base, connectTimeoutSeconds: '45', batchSize: 250 })).toMatchObject({ connectTimeoutSeconds: 45, batchSize: 250 });
  });

  // System name is an optional override. Baking a default in would be
  // indistinguishable from a deliberate choice, so a blank field omits the key.
  it('keeps an explicit system name, trimmed, and omits a blank one', () => {
    expect(buildSqlConfigPayload({ ...base, systemName: ' IdentityIQ ' }).systemName).toBe('IdentityIQ');
    expect(buildSqlConfigPayload({ ...base, systemName: '   ' })).not.toHaveProperty('systemName');
    expect(buildSqlConfigPayload({ ...base, systemName: undefined })).not.toHaveProperty('systemName');
  });

  it('omits schedules when empty and includes them when set', () => {
    expect(buildSqlConfigPayload(base)).not.toHaveProperty('schedules');
    const schedules = [{ enabled: true, syncMode: 'full', frequency: 'daily', hour: 2, minute: 0 }];
    expect(buildSqlConfigPayload({ ...base, schedules }).schedules).toEqual(schedules);
  });

  it('maps every slot through buildQuerySlot, so an assignments slot has no relationshipType', () => {
    const out = buildSqlConfigPayload({ ...base, queries: [slot({ name: 'A', target: 'assignments', resourceType: 'Entitlement' }), slot({ name: 'R', target: 'relationships' })] });
    expect(out.queries[0]).toEqual({ name: 'A', target: 'assignments', sql: 'SELECT 1', enabled: true, resourceType: 'Entitlement', assignmentType: 'Direct', governed: false });
    expect(out.queries[0]).not.toHaveProperty('relationshipType');
    expect(out.queries[1]).toEqual({ name: 'R', target: 'relationships', sql: 'SELECT 1', enabled: true, relationshipType: 'Contains' });
  });

  it('never emits a credential field — those come from buildCredentialFields', () => {
    const out = buildSqlConfigPayload({ ...base, username: 'u', password: 'p' });
    expect(out).not.toHaveProperty('username');
    expect(out).not.toHaveProperty('password');
  });

  it('tolerates a missing queries list', () => {
    expect(buildSqlConfigPayload({ ...base, queries: undefined }).queries).toEqual([]);
  });
});

// ─── Column mapping ──────────────────────────────────────────────────────────
//
// A slot may rename the columns its SELECT returns onto the column contract
// (CLAUDE.md → "Column contract"). The editor holds the mapping as ordered
// rows; crawler.json stores it as an object, so the conversion either way and
// the per-target contract are what these cover.

describe('CONTRACT_COLUMNS / contractColumnsFor / contractColumnOptions', () => {
  it('mirrors the column-contract table per target, required columns first', () => {
    expect(CONTRACT_COLUMNS.identities.required).toEqual(['id', 'displayName']);
    expect(CONTRACT_COLUMNS.resources.required).toEqual(['id', 'displayName']);
    expect(contractColumnOptions('resources')).toEqual(['id', 'displayName', 'name', 'description', 'enabled']);
    expect(contractColumnOptions('identity-members')).toEqual(['identityId', 'principalId', 'isPrimary', 'accountType']);
    expect(contractColumnOptions('assignments')).toEqual(['resourceId', 'principalId', 'identityId']);
    expect(contractColumnsFor('relationships')).toEqual({ required: ['parentId', 'childId'], optional: [] });
  });

  it('offers the person attributes on identities and principals, with identityId only on principals', () => {
    for (const column of ['name', 'userId', 'email', 'givenName', 'surname', 'department', 'jobTitle', 'companyName', 'employeeId', 'principalType', 'enabled', 'active', 'inactive', 'disabled']) {
      expect(contractColumnOptions('identities')).toContain(column);
      expect(contractColumnOptions('principals')).toContain(column);
    }
    // An identities row IS the identity, so there is nothing to point identityId at.
    expect(contractColumnOptions('identities')).not.toContain('identityId');
    expect(contractColumnOptions('principals')).toContain('identityId');
  });

  it('does not offer a resource or relationship column on a person target, or the other way round', () => {
    expect(contractColumnOptions('identities')).not.toContain('parentId');
    expect(contractColumnOptions('identities')).not.toContain('resourceId');
    expect(contractColumnOptions('relationships')).not.toContain('displayName');
    expect(contractColumnOptions('resources')).not.toContain('department');
  });

  it('lists every column once, and nothing at all for an unknown target', () => {
    for (const target of TARGET_IDS) {
      const columns = contractColumnOptions(target);
      expect(columns.length).toBeGreaterThan(1);
      expect(new Set(columns).size).toBe(columns.length);
    }
    expect(contractColumnOptions('groups')).toEqual([]);
    expect(contractColumnsFor(undefined)).toEqual({ required: [], optional: [] });
    // An inherited property name is not a target, so it maps to nothing either.
    expect(contractColumnsFor('constructor')).toEqual({ required: [], optional: [] });
    expect(contractColumnOptions('toString')).toEqual([]);
    expect(validateColumnMap([{ from: 'X', to: 'id' }], 'constructor')).toEqual(['"id" is not a constructor column']);
  });
});

describe('newColumnMapRow', () => {
  it('is a blank row, and a fresh one each time', () => {
    expect(newColumnMapRow()).toEqual({ from: '', to: '' });
    expect(newColumnMapRow()).not.toBe(newColumnMapRow());
  });
});

describe('columnMapToRows / rowsToColumnMap', () => {
  const stored = { EntitlementID: 'id', TechnicalApplication: 'displayName' };

  it('round-trips a stored mapping, keeping its order', () => {
    const rows = columnMapToRows(stored);
    expect(rows).toEqual([{ from: 'EntitlementID', to: 'id' }, { from: 'TechnicalApplication', to: 'displayName' }]);
    expect(rowsToColumnMap(rows)).toEqual(stored);
  });

  it('reads no rows from a missing, empty or non-object mapping', () => {
    expect(columnMapToRows(undefined)).toEqual([]);
    expect(columnMapToRows(null)).toEqual([]);
    expect(columnMapToRows({})).toEqual([]);
    expect(columnMapToRows('id')).toEqual([]);
    expect(columnMapToRows([{ from: 'EntitlementID', to: 'id' }])).toEqual([]);
  });

  it('shows a non-string stored value as text instead of dropping the row', () => {
    expect(columnMapToRows({ Flag: 1 })).toEqual([{ from: 'Flag', to: '1' }]);
    expect(columnMapToRows({ Flag: null })).toEqual([{ from: 'Flag', to: '' }]);
  });

  it('trims both sides and drops blank and half-filled rows', () => {
    expect(rowsToColumnMap([
      { from: '  EntitlementID  ', to: '  id  ' },
      { from: '', to: '' },
      { from: '   ', to: '   ' },
      { from: 'Orphan', to: '' },
      { from: '', to: 'displayName' },
    ])).toEqual({ EntitlementID: 'id' });
  });

  it('keeps the last row when one source column is mapped twice', () => {
    expect(rowsToColumnMap([{ from: 'EntitlementID', to: 'id' }, { from: 'EntitlementID', to: 'displayName' }]))
      .toEqual({ EntitlementID: 'displayName' });
    // Different casings are different object keys, so both survive the conversion.
    expect(rowsToColumnMap([{ from: 'ID', to: 'id' }, { from: 'id', to: 'displayName' }]))
      .toEqual({ ID: 'id', id: 'displayName' });
  });

  it('survives a missing or malformed row list', () => {
    expect(rowsToColumnMap(undefined)).toEqual({});
    expect(rowsToColumnMap('x')).toEqual({});
    expect(rowsToColumnMap([undefined, null, {}])).toEqual({});
  });
});

describe('validateColumnMap', () => {
  it('accepts rows that point at a contract column of their own target', () => {
    expect(validateColumnMap([{ from: 'EntitlementID', to: 'id' }, { from: 'TechnicalApplication', to: 'displayName' }], 'resources')).toEqual([]);
    expect(validateColumnMap([{ from: 'RoleID', to: 'resourceId' }, { from: 'IdentityID', to: 'principalId' }], 'assignments')).toEqual([]);
    expect(validateColumnMap([{ from: 'SupRole', to: 'parentId' }, { from: 'SubRole', to: 'childId' }], 'relationships')).toEqual([]);
    expect(validateColumnMap([{ from: 'EMP_NR', to: 'employeeId' }], 'identities')).toEqual([]);
  });

  it('rejects a contract column that belongs to a different target', () => {
    expect(validateColumnMap([{ from: 'SupRole', to: 'parentId' }], 'identities')).toEqual(['"parentId" is not a identities column']);
    expect(validateColumnMap([{ from: 'Dept', to: 'department' }], 'relationships')).toEqual(['"department" is not a relationships column']);
    // identityId is an accepted alias on an assignments row, but not a column of an identities row.
    expect(validateColumnMap([{ from: 'IdentityID', to: 'identityId' }], 'assignments')).toEqual([]);
    expect(validateColumnMap([{ from: 'IdentityID', to: 'identityId' }], 'identities')).toEqual(['"identityId" is not a identities column']);
  });

  it('rejects a target column that is not a contract column at all', () => {
    expect(validateColumnMap([{ from: 'X', to: 'ID' }], 'identities')).toEqual(['"ID" is not a identities column']);
    expect(validateColumnMap([{ from: 'X', to: 'id' }], 'groups')).toEqual(['"id" is not a groups column']);
  });

  it('rejects a half-filled row and ignores a wholly blank one', () => {
    expect(validateColumnMap([{ from: 'EntitlementID', to: '  ' }], 'resources')).toEqual(['source column "EntitlementID" is not mapped to anything']);
    expect(validateColumnMap([{ from: '  ', to: 'id' }], 'resources')).toEqual(['map to "id" is missing the source column name']);
    expect(validateColumnMap([newColumnMapRow(), { from: '', to: '' }], 'resources')).toEqual([]);
  });

  it('reports a repeated source column once, case-insensitively', () => {
    expect(validateColumnMap([{ from: 'ID', to: 'id' }, { from: 'id', to: 'displayName' }], 'resources')).toEqual(['source column "id" is mapped twice']);
    expect(validateColumnMap([{ from: 'A', to: 'id' }, { from: 'B', to: 'displayName' }], 'resources')).toEqual([]);
  });

  it('reports every bad row, in row order', () => {
    expect(validateColumnMap([
      { from: 'SupRole', to: 'parentId' },
      { from: 'EMP', to: 'employeeId' },
      { from: 'emp', to: 'department' },
    ], 'identities')).toEqual(['"parentId" is not a identities column', 'source column "emp" is mapped twice']);
  });

  it('has nothing to report without rows', () => {
    expect(validateColumnMap(undefined, 'identities')).toEqual([]);
    expect(validateColumnMap([], 'identities')).toEqual([]);
  });
});

describe('validateQueries — column mapping', () => {
  it('reports a column-map error under the slot name, alongside the slot other errors', () => {
    expect(validateQueries([slot({ name: 'Users', columnMap: [{ from: 'SupRole', to: 'parentId' }] })]))
      .toEqual(['Users: "parentId" is not a identities column']);
    expect(validateQueries([slot({ name: '', sql: '', columnMap: [{ from: '', to: 'id' }] })]))
      .toEqual(['Query 1: name is required', 'Query 1: SQL is required', 'Query 1: map to "id" is missing the source column name']);
  });

  it('passes a slot whose mapping is valid and blocks the step on one that is not', () => {
    expect(validateQueries([slot({ columnMap: [{ from: 'EMP_NR', to: 'employeeId' }] })])).toEqual([]);
    expect(canSubmitQueries([slot({ columnMap: [{ from: 'EMP_NR', to: 'employeeId' }] })])).toBe(true);
    expect(canSubmitQueries([slot({ columnMap: [{ from: 'EMP_NR', to: 'parentId' }] })])).toBe(false);
  });
});

describe('toSlotState / seedWizardState — column mapping', () => {
  const storedSlot = {
    name: 'Entitlements', target: 'resources', sql: 'SELECT 1', resourceType: 'Entitlement',
    columnMap: { EntitlementID: 'id', TechnicalApplication: 'displayName' },
  };

  it('seeds a stored mapping object as editable rows', () => {
    const rows = seedWizardState({ server: 'h', queries: [storedSlot] }).queries[0].columnMap;
    expect(rows).toEqual([{ from: 'EntitlementID', to: 'id' }, { from: 'TechnicalApplication', to: 'displayName' }]);
  });

  it('seeds no rows for a slot without a mapping', () => {
    expect(toSlotState({ name: 'X', target: 'identities', sql: 's' }).columnMap).toEqual([]);
    expect(seedWizardState({ queries: [{ name: 'X', target: 'identities', sql: 's' }] }).queries[0].columnMap).toEqual([]);
  });

  it('re-seeding an editor slot keeps its rows, trimmed, rather than emptying them', () => {
    expect(toSlotState({ name: 'X', target: 'identities', sql: 's', columnMap: [{ from: ' EMP_NR ', to: ' employeeId ' }] }).columnMap)
      .toEqual([{ from: 'EMP_NR', to: 'employeeId' }]);
  });

  it('a seeded slot saves back to the stored shape unchanged', () => {
    const seeded = seedWizardState({ server: 'h', queries: [storedSlot] }).queries[0];
    expect(buildQuerySlot(seeded).columnMap).toEqual(storedSlot.columnMap);
  });
});

describe('buildQuerySlot / buildSqlConfigPayload — column mapping', () => {
  const base = {
    server: 'sql01', port: '', database: 'iiq', encrypt: true, trustServerCertificate: false,
    connectTimeoutSeconds: 30, commandTimeoutSeconds: 600, batchSize: 5000, pageSize: 10000,
    systemName: '', schedules: [],
  };

  it('omits columnMap entirely when no row is usable', () => {
    expect(buildQuerySlot(slot())).not.toHaveProperty('columnMap');
    expect(buildQuerySlot(slot({ columnMap: [] }))).not.toHaveProperty('columnMap');
    expect(buildQuerySlot(slot({ columnMap: [newColumnMapRow(), { from: 'Orphan', to: '' }] }))).not.toHaveProperty('columnMap');
    expect(buildSqlConfigPayload({ ...base, queries: [slot()] }).queries[0]).not.toHaveProperty('columnMap');
  });

  it('saves the filled rows as the object crawler.json takes, trimmed', () => {
    const out = buildQuerySlot(slot({
      target: 'resources', resourceType: 'Entitlement',
      columnMap: [{ from: ' EntitlementID ', to: 'id' }, { from: 'TechnicalApplication', to: 'displayName' }, newColumnMapRow()],
    }));
    expect(out.columnMap).toEqual({ EntitlementID: 'id', TechnicalApplication: 'displayName' });
    expect(out).toMatchObject({ name: 'Q', target: 'resources', sql: 'SELECT 1', enabled: true, resourceType: 'Entitlement' });
  });

  it('carries each slot mapping through the saved payload', () => {
    const out = buildSqlConfigPayload({
      ...base,
      queries: [
        slot({ name: 'Users', columnMap: [{ from: 'IdentityID', to: 'id' }] }),
        slot({ name: 'Links', target: 'identity-members' }),
      ],
    });
    expect(out.queries[0].columnMap).toEqual({ IdentityID: 'id' });
    expect(out.queries[1]).not.toHaveProperty('columnMap');
  });
});
