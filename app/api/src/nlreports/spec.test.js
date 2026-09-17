import { describe, it, expect } from 'vitest';
import { validateSpec, resolveColumn, availableColumns, MAX_LIMIT } from './spec.js';

const values = { principalType: ['ServicePrincipal', 'User'], userType: ['Guest', 'Member'], resourceType: ['Group'] };

describe('validateSpec', () => {
  it('normalises the guest-without-active-manager spec', () => {
    const { ok, spec, errors } = validateSpec({
      entity: 'users',
      conditions: [
        { type: 'field', field: 'userType', op: 'eq', value: 'guest' },
        { type: 'group', match: 'any', conditions: [
          { type: 'relation', relation: 'manager', quantifier: 'none', conditions: [] },
          { relation: 'manager', quantifier: 'some', conditions: [{ field: 'accountEnabled', op: 'eq', value: 'false' }] },
        ] },
      ],
      columns: ['displayName', 'id', 'id'],
    }, values);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(spec.entity).toBe('user');
    expect(spec.conditions[0].value).toBe('Guest'); // snapped to the real enum value
    expect(spec.conditions[1].conditions[1]).toEqual({
      type: 'relation', relation: 'manager', quantifier: 'some', match: 'all',
      conditions: [{ type: 'field', field: 'accountEnabled', op: 'eq', value: false }],
    });
    expect(spec.columns).toEqual(['displayName', 'id']);
  });

  it('rejects unknown entities, fields, operators and enum values with actionable messages', () => {
    expect(validateSpec({ entity: 'tables' }).errors[0]).toMatch(/unknown entity/);
    const { ok, errors } = validateSpec({
      entity: 'account',
      conditions: [
        { field: 'password', op: 'eq', value: 'x' },
        { field: 'accountEnabled', op: 'contains', value: 'x' },
        { field: 'userType', op: 'eq', value: 'Contractor' },
      ],
    }, values);
    expect(ok).toBe(false);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/"password" is not a field of account/);
    expect(errors[1]).toMatch(/operator "contains" is not allowed on "accountEnabled"/);
    expect(errors[2]).toMatch(/Known values: Guest, Member/);
  });

  it('drops a restated implied type on user/group, but rejects a different type', () => {
    const ok = validateSpec({
      entity: 'group',
      conditions: [{ field: 'resourceType', op: 'eq', value: 'group' }, { field: 'displayName', op: 'contains', value: 'LIC' }],
      columns: ['displayName', 'resourceType'],
    }, values);
    expect(ok.errors).toEqual([]);
    expect(ok.spec.conditions).toEqual([{ type: 'field', field: 'displayName', op: 'contains', value: 'LIC' }]);
    expect(ok.spec.columns).toEqual(['displayName']);

    const bad = validateSpec({ entity: 'user', conditions: [{ field: 'principalType', op: 'eq', value: 'ServicePrincipal' }] }, values);
    expect(bad.errors[0]).toMatch(/use the account entity/);
  });

  it('snaps an abbreviated enum value only when exactly one known value contains it', () => {
    const vals = { resourceType: ['EntraDirectoryRole', 'Group', 'AppRole', 'AzureRoleAssignment'], systemName: ['Azure RM (3c4f)', 'Entra ID (3c4f)'] };
    const one = validateSpec({ entity: 'resource', conditions: [
      { field: 'resourceType', op: 'eq', value: 'DirectoryRole' },
      { field: 'system', op: 'eq', value: 'azure rm' },
    ] }, vals);
    expect(one.errors).toEqual([]);
    expect(one.spec.conditions.map(c => c.value)).toEqual(['EntraDirectoryRole', 'Azure RM (3c4f)']);

    expect(validateSpec({ entity: 'resource', conditions: [{ field: 'resourceType', op: 'eq', value: 'Role' }] }, vals).errors[0])
      .toMatch(/"Role" is not a known value/); // AppRole, EntraDirectoryRole, AzureRoleAssignment — ambiguous
    expect(validateSpec({ entity: 'resource', conditions: [{ field: 'resourceType', op: 'eq', value: 'Gr' }] }, vals).errors[0])
      .toMatch(/is not a known value/); // too short to trust
  });

  it('refuses nested relations and nested groups', () => {
    const { errors } = validateSpec({
      entity: 'account',
      conditions: [
        { relation: 'manager', conditions: [{ relation: 'memberOf', conditions: [] }] },
        { type: 'group', conditions: [{ type: 'group', conditions: [] }] },
      ],
    }, values);
    expect(errors).toEqual(expect.arrayContaining([
      'a relation condition cannot be nested inside another relation',
      'groups cannot be nested',
    ]));
  });

  it('requires a value only for operators that take one, and coerces by type', () => {
    const { ok, spec } = validateSpec({
      entity: 'resource',
      conditions: [
        { field: 'description', op: 'isEmpty', value: 'ignored' },
        { field: 'memberCount', op: 'gt', value: '20' },
        { field: 'createdDateTime', op: 'olderThanDays', value: 90 },
      ],
    }, values);
    expect(ok).toBe(true);
    expect(spec.conditions[0]).not.toHaveProperty('value');
    expect(spec.conditions[1].value).toBe(20);
    expect(validateSpec({ entity: 'resource', conditions: [{ field: 'displayName', op: 'contains' }] }).errors[0]).toMatch(/needs a value/);
    expect(validateSpec({ entity: 'resource', conditions: [{ field: 'memberCount', op: 'gt', value: 'lots' }] }).errors[0]).toMatch(/is a number/);
  });

  it('falls back to default columns and caps the limit', () => {
    const { spec } = validateSpec({ entity: 'resource', limit: 999999 });
    expect(spec.columns).toEqual(['displayName', 'resourceType', 'description']);
    expect(spec.limit).toBe(MAX_LIMIT);
  });
});

describe('columns', () => {
  it('resolves one-relation fields and many-relation aggregates only', () => {
    expect(resolveColumn('account', 'manager.displayName').kind).toBe('oneRelationField');
    expect(resolveColumn('account', 'memberOf.names').kind).toBe('manyNames');
    expect(resolveColumn('account', 'memberOf.displayName')).toBeNull();
    expect(resolveColumn('account', 'manager.count')).toBeNull();
    expect(resolveColumn('account', 'manager.displayName.x')).toBeNull();
  });

  it('offers every pickable column with a label', () => {
    const cols = availableColumns('account');
    expect(cols.map(c => c.key)).toEqual(expect.arrayContaining(['displayName', 'manager.displayName', 'memberOf.count']));
    expect(cols.every(c => c.label)).toBe(true);
  });
});
