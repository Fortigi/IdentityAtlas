import { describe, it, expect } from 'vitest';
import { validateSpec, resolveColumn, availableColumns, groupableFields, MAX_LIMIT, MAX_IN_VALUES } from './spec.js';

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

  it('offers the business roles of an account, the way it always has for a group', () => {
    // The prompt has told the model for as long as it has existed that membership
    // of a business role is the businessRoles relation. On a user it was not one,
    // so the model could only answer that no such field exists.
    expect(resolveColumn('user', 'businessRoles.names'))
      .toEqual({ key: 'businessRoles.names', label: 'Business roles', kind: 'manyNames', relation: 'businessRoles' });
    expect(availableColumns('user').map(c => c.key)).toContain('businessRoles.names');
    expect(availableColumns('account').map(c => c.key)).toContain('businessRoles.count');
    expect(availableColumns('group').map(c => c.key)).toContain('businessRoles.names');

    const { ok, errors, spec } = validateSpec({
      entity: 'user',
      conditions: [{ type: 'relation', relation: 'businessRoles', quantifier: 'some', conditions: [{ field: 'displayName', op: 'contains', value: 'Finance' }] }],
      columns: ['displayName', 'businessRoles.names'],
    });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(spec.columns).toEqual(['displayName', 'businessRoles.names']);
  });
  it('offers every pickable column with a label', () => {
    const cols = availableColumns('account');
    expect(cols.map(c => c.key)).toEqual(expect.arrayContaining(['displayName', 'manager.displayName', 'memberOf.count']));
    expect(cols.every(c => c.label)).toBe(true);
  });
});

describe('"is one of" takes a list', () => {
  const check = (raw) => validateSpec({ entity: 'resource', conditions: [raw] }, values);
  const inCond = (value, field = 'id') => check({ field, op: 'in', value });

  it('keeps every value in the list', () => {
    const { ok, spec } = inCond(['g1', 'g2', 'g3']);
    expect(ok).toBe(true);
    expect(spec.conditions[0].value).toEqual(['g1', 'g2', 'g3']);
  });

  it('accepts a single value written without a list', () => {
    // A small model that writes "value": "g1" for an "in" means the same thing.
    const { ok, spec } = inCond('g1');
    expect(ok).toBe(true);
    expect(spec.conditions[0].value).toEqual(['g1']);
  });

  it('refuses an empty list instead of matching everything', () => {
    // The dangerous failure: an "in" with no values compiling to no condition
    // at all would widen the report from "these 27 groups" to every group.
    const { ok, errors } = inCond([]);
    expect(ok).toBe(false);
    expect(errors.join(' ')).toMatch(/needs a value|at least one value/);
  });

  it('refuses a list longer than the cap, naming the cap', () => {
    const { ok, errors } = inCond(Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => `g${i}`));
    expect(ok).toBe(false);
    expect(errors.join(' ')).toContain(String(MAX_IN_VALUES));
  });

  it('accepts a list exactly at the cap', () => {
    // The boundary from the other side, so the cap is off-by-one-proof.
    expect(inCond(Array.from({ length: MAX_IN_VALUES }, (_, i) => `g${i}`)).ok).toBe(true);
  });

  it('coerces each value the way the field would coerce one', () => {
    // An enum list resolves to the catalog's canonical spelling, per value.
    const { ok, spec } = check({ field: 'resourceType', op: 'in', value: ['group'] });
    expect(ok).toBe(true);
    expect(spec.conditions[0].value).toEqual(['Group']);
  });

  it('is offered on text and enum, and refused on everything else', () => {
    expect(inCond(['x'], 'displayName').ok).toBe(true);
    expect(check({ field: 'resourceType', op: 'in', value: ['Group'] }).ok).toBe(true);
    // A list of numbers or dates has no meaning the catalog can compile.
    const onNumber = validateSpec(
      { entity: 'resource', conditions: [{ field: 'memberCount', op: 'in', value: [1, 2] }] }, values);
    expect(onNumber.ok).toBe(false);
    expect(onNumber.errors.join(' ')).toMatch(/not allowed/);
  });
});

// ─── This deployment's own attributes, and grouping ──────────────────

const RAW = 'extension_a1b2c3d4e5f60718293a4b5c6d7e8f90_sfDepartmentID';
const extFields = {
  user: {
    [`ext.${RAW}`]: {
      label: 'sfDepartmentID', type: 'text', extKey: RAW, discovered: true,
      sql: (t) => `${t}."extendedAttributes"->>'${RAW}'`,
    },
  },
};

describe('discovered attributes', () => {
  it('filters and shows an attribute this deployment has, like any other field', () => {
    const { ok, spec, errors } = validateSpec({
      entity: 'user',
      conditions: [{ field: `ext.${RAW}`, op: 'contains', value: 'FIN' }],
      columns: ['displayName', `ext.${RAW}`],
    }, values, extFields);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(spec.conditions[0]).toEqual({ type: 'field', field: `ext.${RAW}`, op: 'contains', value: 'FIN' });
    expect(spec.columns).toEqual(['displayName', `ext.${RAW}`]);
  });

  it('rejects the same attribute on a deployment that does not have it', () => {
    const { ok, errors } = validateSpec({
      entity: 'user', conditions: [{ field: `ext.${RAW}`, op: 'contains', value: 'FIN' }],
    }, values, {});
    expect(ok).toBe(false);
    expect(errors[0]).toContain(`"ext.${RAW}" is not a field of user`);
    // The repair message lists the catalog's fields, never a deployment's hundreds.
    expect(errors[0].split('Fields: ')[1]).not.toContain('ext.');

  });

  it('offers an attribute as a column and as something to group on', () => {
    expect(resolveColumn('user', `ext.${RAW}`, extFields)).toEqual({
      key: `ext.${RAW}`, label: 'sfDepartmentID', kind: 'field', field: `ext.${RAW}`, discovered: true,
    });
    expect(availableColumns('user', extFields)).toContainEqual({
      key: `ext.${RAW}`, label: 'sfDepartmentID', kind: 'field', field: `ext.${RAW}`, discovered: true,
    });
    expect(groupableFields('user', extFields)).toContainEqual({ name: `ext.${RAW}`, label: 'sfDepartmentID', discovered: true });
  });

  it('does not offer an attribute of another entity, or a date, to group on', () => {
    expect(groupableFields('group', extFields).map(f => f.name)).not.toContain(`ext.${RAW}`);
    const names = groupableFields('user').map(f => f.name);
    expect(names).toContain('department');
    expect(names).not.toContain('createdDateTime');
    expect(names).not.toContain('lastSignIn');
  });
});

describe('grouping', () => {
  it('keeps a groupBy on a field of the entity', () => {
    const { ok, spec, errors } = validateSpec({ entity: 'users', groupBy: 'department' }, values);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(spec.groupBy).toBe('department');
  });

  it('groups on a discovered attribute too', () => {
    const { ok, spec } = validateSpec({ entity: 'user', groupBy: `ext.${RAW}` }, values, extFields);
    expect(ok).toBe(true);
    expect(spec.groupBy).toBe(`ext.${RAW}`);
  });

  it('leaves groupBy out entirely when nothing was asked for', () => {
    const { spec } = validateSpec({ entity: 'user', groupBy: '' }, values);
    expect(spec).not.toHaveProperty('groupBy');
    expect(validateSpec({ entity: 'user' }, values).spec).not.toHaveProperty('groupBy');
  });

  it('refuses to group on a date, which would make one group per row', () => {
    const { ok, errors } = validateSpec({ entity: 'user', groupBy: 'createdDateTime' }, values);
    expect(ok).toBe(false);
    expect(errors[0]).toContain('holds a date');
  });

  it('refuses an unknown field, a relation and anything that is not a field name', () => {
    expect(validateSpec({ entity: 'user', groupBy: 'nope' }, values).errors[0])
      .toBe('"nope" is not a field of user, so a report cannot be grouped on it');
    expect(validateSpec({ entity: 'user', groupBy: 'memberOf' }, values).ok).toBe(false);
    expect(validateSpec({ entity: 'user', groupBy: { field: 'department' } }, values).errors[0])
      .toBe('groupBy must be the name of a field');
  });

  it('refuses to group a report that compares sets', () => {
    const { ok, errors } = validateSpec({
      entity: 'user', groupBy: 'department',
      conditions: [{ type: 'compare', relation: 'memberOf', measure: 'identical', minSimilarity: 100, reference: { entity: 'user', name: 'Jan' } }],
    }, values);
    expect(ok).toBe(false);
    expect(errors).toContain('a report that compares sets cannot also be grouped');
  });

  it('sorts a grouped report on the count or on the grouped value, and nothing else', () => {
    const onCount = validateSpec({ entity: 'user', groupBy: 'department', sort: { field: 'count', direction: 'desc' } }, values);
    expect(onCount.ok).toBe(true);
    expect(onCount.spec.sort).toEqual({ field: 'count', direction: 'desc' });

    const onValue = validateSpec({ entity: 'user', groupBy: 'department', sort: { field: 'department' } }, values);
    expect(onValue.spec.sort).toEqual({ field: 'department', direction: 'asc' });

    const onOther = validateSpec({ entity: 'user', groupBy: 'department', sort: { field: 'displayName' } }, values);
    expect(onOther.ok).toBe(false);
    expect(onOther.errors[0]).toBe('a grouped report can only be sorted on "department" or "count"');
  });

  it('refuses to sort on the count when the report is not grouped', () => {
    const { ok, errors } = validateSpec({ entity: 'user', sort: { field: 'count' } }, values);
    expect(ok).toBe(false);
    expect(errors[0]).toBe('cannot sort on "count"');
  });
});
