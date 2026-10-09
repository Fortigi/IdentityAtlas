import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');

import { query } from '../../db/connection.js';
import {
  allowedFields, buildTargetsSql, loadTargets, displayNameOnly, buildRuleIndex, loadRuleIndexes, TARGET_TABLES,
} from './candidates.js';

beforeEach(() => { query.mockReset(); });

const rule = (signals, extra = {}) => ({
  entityType: 'Person', targetType: 'Principal', threshold: 50,
  signals: signals.map((s, i) => ({ name: `${s.attribute}→${s.targetField}`, weight: 50, order: i, ...s })),
  ...extra,
});

describe('allowedFields (the whitelist)', () => {
  it('keeps only LINK_TARGETS fields, in LINK_TARGETS order', () => {
    expect(allowedFields('Principal', ['displayName', 'email', 'password', 'extendedAttributes'])).toEqual(['email', 'displayName']);
    expect(allowedFields('Resource', ['mail', 'email'])).toEqual(['mail']);
  });
  it('throws on a target type outside LINK_TARGETS', () => {
    expect(() => allowedFields('Systems', ['displayName'])).toThrow(/Unknown link target type "Systems"/);
  });
  it('gives nothing for no fields', () => {
    expect(allowedFields('Context', undefined)).toEqual([]);
  });
});

describe('buildTargetsSql', () => {
  it('never puts a non-whitelisted field into the SELECT', () => {
    const sql = buildTargetsSql('Principal', ['email', '"; DROP TABLE "Principals"; --', 'riskScore']);
    expect(sql).toBe('SELECT "id", "displayName", "email", "principalType" FROM "Principals" WHERE "deletedAt" IS NULL');
  });
  it('filters soft-deleted rows only on tables that have deletedAt, and ownership rows out of Resources', () => {
    expect(buildTargetsSql('Resource', ['externalId'])).toBe('SELECT "id", "displayName", "externalId" FROM "Resources" WHERE "deletedAt" IS NULL AND ("resourceType" IS NULL OR "resourceType" NOT IN (\'GroupOwnership\',\'ServicePrincipalOwnership\',\'ApplicationOwnership\',\'ResourceOwnership\'))');
    expect(buildTargetsSql('Identity', ['employeeId'])).toBe('SELECT "id", "displayName", "employeeId" FROM "Identities"');
    expect(buildTargetsSql('Context', ['displayName'])).toBe('SELECT "id", "displayName" FROM "Contexts"');
  });
  it('maps every LINK_TARGETS type to a table', () => {
    expect(Object.keys(TARGET_TABLES).sort()).toEqual(['Context', 'Identity', 'OrgEntity', 'Principal', 'Resource']);
  });
  it('OrgEntity: only current accepted entities of OrgEntities, with their entityType', () => {
    expect(buildTargetsSql('OrgEntity', ['displayName', 'attributes']))
      .toBe('SELECT "id", "displayName", "entityType" FROM "OrgEntities" WHERE "status" = \'accepted\' AND "validTo" IS NULL');
  });
});

describe('loadTargets', () => {
  it('runs the whitelisted SELECT without parameters and returns the rows', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'p1' }] });
    expect(await loadTargets('Identity', ['email', 'bogus'])).toEqual([{ id: 'p1' }]);
    expect(query).toHaveBeenCalledWith('SELECT "id", "displayName", "email" FROM "Identities"');
  });
});

describe('loadTargets by rule', () => {
  it('excludes non-human principals in SQL when a signal targets a field other than displayName', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await loadTargets('Principal', rule([{ attribute: 'email', targetField: 'email', type: 'exact' }]));
    expect(query).toHaveBeenCalledWith(
      'SELECT "id", "displayName", "email", "principalType" FROM "Principals" WHERE "deletedAt" IS NULL AND ("principalType" IS NULL OR "principalType" <> ALL($1::text[]))',
      [['ServicePrincipal', 'ManagedIdentity', 'AIAgent']],
    );
  });
  it('keeps them for a displayName-only rule, and never filters other target types', async () => {
    query.mockResolvedValue({ rows: [] });
    await loadTargets('Principal', rule([{ attribute: 'displayName', targetField: 'displayName', type: 'token' }]));
    expect(query).toHaveBeenLastCalledWith('SELECT "id", "displayName", "principalType" FROM "Principals" WHERE "deletedAt" IS NULL');
    await loadTargets('Identity', rule([{ attribute: 'email', targetField: 'email', type: 'exact' }]));
    expect(query).toHaveBeenLastCalledWith('SELECT "id", "displayName", "email" FROM "Identities"');
  });
  it('a rule without signals loads the bare columns', async () => {
    query.mockResolvedValue({ rows: [] });
    await loadTargets('Context', { targetType: 'Context' });
    expect(query).toHaveBeenLastCalledWith('SELECT "id", "displayName" FROM "Contexts"');
  });
});

describe('displayNameOnly', () => {
  it('is true only when every signal targets displayName', () => {
    expect(displayNameOnly(rule([{ attribute: 'displayName', targetField: 'displayName', type: 'token' }]))).toBe(true);
    expect(displayNameOnly(rule([
      { attribute: 'displayName', targetField: 'displayName', type: 'name' },
      { attribute: 'email', targetField: 'email', type: 'exact' },
    ]))).toBe(false);
  });
});

describe('buildRuleIndex', () => {
  const rows = [
    { id: 'u1', displayName: 'Jane Doe', email: 'jane.doe@contoso.com', principalType: 'User' },
    { id: 'u2', displayName: 'John Doe', email: 'JANE.DOE@contoso.com', principalType: 'User' },
    { id: 'sp', displayName: 'Payroll App', email: null, principalType: 'ServicePrincipal' },
    { id: 'mi', displayName: 'Jane Doe', email: 'jane.doe@contoso.com', principalType: 'ManagedIdentity' },
  ];

  it('indexes each signal under its normalised key; several rows may share a key', () => {
    const r = rule([{ attribute: 'email', targetField: 'email', type: 'exact' }]);
    const idx = buildRuleIndex(rows, r).bySignal.get('email→email');
    expect(idx.get('jane.doe@contoso.com').map(x => x.id)).toEqual(['u1', 'u2']);
  });

  it('drops non-human principals when any signal targets a field other than displayName', () => {
    const r = rule([
      { attribute: 'email', targetField: 'email', type: 'exact' },
      { attribute: 'displayName', targetField: 'displayName', type: 'name' },
    ]);
    const { bySignal } = buildRuleIndex(rows, r);
    expect(bySignal.get('displayName→displayName').get('doe').map(x => x.id)).toEqual(['u1', 'u2']);
    expect([...bySignal.get('email→email').values()].flat().map(x => x.id)).not.toContain('mi');
  });

  it('keeps non-human principals for a displayName-only rule', () => {
    const r = rule([{ attribute: 'displayName', targetField: 'displayName', type: 'token' }]);
    const idx = buildRuleIndex(rows, r).bySignal.get('displayName→displayName');
    expect(idx.get('payroll').map(x => x.id)).toEqual(['sp']);
    expect(idx.get('jane').map(x => x.id)).toEqual(['u1', 'mi']);
  });

  it('an OrgEntity rule never indexes entities of its own entity type', () => {
    const orgRows = [
      { id: 'c1', displayName: 'Contoso', entityType: 'Customer' },
      { id: 't1', displayName: 'Contoso', entityType: 'Timesheet' },
    ];
    const r = rule([{ attribute: 'customer', targetField: 'displayName', type: 'exact' }], { entityType: 'Timesheet', targetType: 'OrgEntity' });
    expect(buildRuleIndex(orgRows, r).bySignal.get('customer→displayName').get('contoso').map(x => x.id)).toEqual(['c1']);
    // the same rows under a non-OrgEntity rule keep both (entityType is no filter there)
    const other = rule([{ attribute: 'customer', targetField: 'displayName', type: 'exact' }], { entityType: 'Timesheet', targetType: 'Context' });
    expect(buildRuleIndex(orgRows, other).bySignal.get('customer→displayName').get('contoso').map(x => x.id)).toEqual(['c1', 't1']);
  });

  it('indexes nothing for an empty target value or a field the rows do not carry', () => {
    const r = rule([{ attribute: 'email', targetField: 'employeeId', type: 'exact' }]);
    expect(buildRuleIndex(rows, r).bySignal.get('email→employeeId').size).toBe(0);
  });
});

describe('loadRuleIndexes', () => {
  it('loads each target type once with the union of the fields its rules need', async () => {
    query.mockImplementation(async (sql) => ({
      rows: sql.includes('"Principals"')
        ? [{ id: 'u1', displayName: 'Jane Doe', email: 'jane@contoso.com', employeeId: 'E1', principalType: 'User' }]
        : [{ id: 'r1', displayName: 'SG_SAP_PROD' }],
    }));
    const rules = [
      rule([{ attribute: 'email', targetField: 'email', type: 'exact' }], { entityType: 'Owner' }),
      rule([{ attribute: 'id', targetField: 'employeeId', type: 'exact' }], { entityType: 'Member' }),
      rule([{ attribute: 'displayName', targetField: 'displayName', type: 'token' }], { entityType: 'App', targetType: 'Resource' }),
    ];
    const out = await loadRuleIndexes(rules);
    expect(query).toHaveBeenCalledTimes(2);
    // two rules on Principal → one shared load with the union of fields, no SQL filter
    expect(query.mock.calls[0]).toEqual(['SELECT "id", "displayName", "email", "employeeId", "principalType" FROM "Principals" WHERE "deletedAt" IS NULL']);
    // keyed by rule name, so an entity type may carry several rules
    expect([...out.keys()]).toEqual(['Owner → Principal via email', 'Member → Principal via id', 'App → Resource via displayName']);
    expect(out.get('Member → Principal via id').bySignal.get('id→employeeId').get('e1')[0].id).toBe('u1');
    expect(out.get('App → Resource via displayName').bySignal.get('displayName→displayName').get('sap')[0].id).toBe('r1');
  });

  it('loads nothing for no rules', async () => {
    expect((await loadRuleIndexes(undefined)).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
