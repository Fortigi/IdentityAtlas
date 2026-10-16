import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');

import { query } from '../../db/connection.js';
import {
  detectLinks, detectPairs, entitiesFromRows, attributeShape, signalTypesFor, suggestedWeight, probesFor, SHAPE_SHARE,
} from './detect.js';

const principals = [
  { id: 'u1', displayName: 'Ann Smith', email: 'ann@contoso.com', employeeId: 'E1', principalType: 'User' },
  { id: 'u2', displayName: 'Bob Jones', email: 'bob@contoso.com', employeeId: 'E2', principalType: 'User' },
  { id: 'u3', displayName: 'Bob Jones', email: 'adm-bob@contoso.com', employeeId: null, principalType: 'User' },
  { id: 'u4', displayName: 'Cas Lee', email: 'cas@contoso.com', employeeId: 'E4', principalType: 'User' },
];
const resources = [
  { id: 'r1', displayName: 'SG_SAP_PROD_Users', mail: null, externalId: 'X1' },
  { id: 'r2', displayName: 'SG_HR_Users', mail: 'hr@contoso.com', externalId: 'X2' },
];

const person = (displayName, attributes) => ({ entityType: 'Person', displayName, canonicalKey: displayName, attributes });
const people = [
  person('Ann Smith', { email: 'ann@contoso.com', code: 'E1' }),
  person('Bob Jones', { email: 'bob@contoso.com', code: 'E2' }),
  person('Cas Lee', { email: '', code: 'E4' }),
  person('Dee Unknown', { email: 'dee@contoso.com', code: 'E9' }),
];

const find = (pairs, attribute, targetType, targetField, type) =>
  pairs.find(p => p.attribute === attribute && p.targetType === targetType && p.targetField === targetField && p.type === type);

describe('attributeShape', () => {
  it('is email at the 80 % share, text just under it', () => {
    expect(SHAPE_SHARE).toBe(0.8);
    expect(attributeShape(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'plain'])).toBe('email');   // 4/5
    expect(attributeShape(['a@x.com', 'b@x.com', 'c@x.com', 'plain', 'plain'])).toBe('text');      // 3/5
  });
  it('ignores empty values and is null when every value is empty', () => {
    expect(attributeShape(['', 'a@x.com'])).toBe('email');
    expect(attributeShape(['', ''])).toBeNull();
  });
  it('a value with @ but no domain dot is not an address', () => {
    expect(attributeShape(['someone@host'])).toBe('text');
  });
});

describe('signalTypesFor', () => {
  it('always exact; prefix for an address against an e-mail field', () => {
    expect(signalTypesFor('email', 'Principal', 'email')).toEqual(['exact', 'prefix']);
    expect(signalTypesFor('email', 'Resource', 'mail')).toEqual(['exact', 'prefix']);
    expect(signalTypesFor('email', 'Principal', 'displayName')).toEqual(['exact']);
  });
  it('name against person display names, token against group and context names', () => {
    expect(signalTypesFor('text', 'Identity', 'displayName')).toEqual(['exact', 'name']);
    expect(signalTypesFor('text', 'Resource', 'displayName')).toEqual(['exact', 'token', 'fuzzy']);
    expect(signalTypesFor('text', 'Context', 'displayName')).toEqual(['exact', 'token', 'fuzzy']);
    expect(signalTypesFor('text', 'OrgEntity', 'displayName')).toEqual(['exact', 'fuzzy']);
    expect(signalTypesFor('email', 'OrgEntity', 'displayName')).toEqual(['exact']);
    expect(signalTypesFor('text', 'Resource', 'mail')).toEqual(['exact']);
    expect(signalTypesFor('text', 'Principal', 'email')).toEqual(['exact']);
  });
});

describe('suggestedWeight', () => {
  it('follows the handover table', () => {
    expect(suggestedWeight('exact', 'email')).toBe(90);
    expect(suggestedWeight('exact', 'mail')).toBe(90);
    expect(suggestedWeight('exact', 'employeeId')).toBe(95);
    expect(suggestedWeight('exact', 'externalId')).toBe(95);
    expect(suggestedWeight('exact', 'displayName')).toBe(70);
    expect(suggestedWeight('name', 'displayName')).toBe(60);
    expect(suggestedWeight('prefix', 'email')).toBe(80);
    expect(suggestedWeight('token', 'displayName')).toBe(50);
    expect(suggestedWeight('fuzzy', 'displayName')).toBe(100);
    expect(suggestedWeight('fuzzy', 'externalId')).toBe(100);
  });
});

describe('probesFor', () => {
  it('nothing for an all-empty attribute, and only loaded target types', () => {
    expect(probesFor(null, new Map([['Principal', []]]))).toEqual([]);
    const p = probesFor('text', new Map([['Context', []]]));
    expect(p).toEqual([
      { targetType: 'Context', targetField: 'displayName', type: 'exact' },
      { targetType: 'Context', targetField: 'displayName', type: 'token' },
      { targetType: 'Context', targetField: 'displayName', type: 'fuzzy' },
    ]);
    expect(probesFor('text', new Map([['OrgEntity', []]]))).toEqual([
      { targetType: 'OrgEntity', targetField: 'displayName', type: 'exact' },
      { targetType: 'OrgEntity', targetField: 'displayName', type: 'fuzzy' },
    ]);
  });
});

describe('detectPairs', () => {
  const rowsByType = new Map([['Principal', principals], ['Resource', resources]]);
  const pairs = detectPairs(people, ['displayName', 'email', 'code'], rowsByType);

  it('counts unique, multiple and none per value; an empty value is not counted at all', () => {
    expect(find(pairs, 'email', 'Principal', 'email', 'exact')).toEqual({
      attribute: 'email', targetType: 'Principal', targetField: 'email', type: 'exact',
      unique: 2, multiple: 0, none: 1, values: 3, uniquePct: 67, suggestedWeight: 90, // Cas's empty e-mail is no miss
    });
  });

  it('a cell listing several people counts per person, and the percentage is per value', () => {
    const team = [{ entityType: 'Team', displayName: 'T1', attributes: { members: 'Ann Smith;#27;#Bob Jones;#16;#Nobody Here;#3' } }];
    const p = find(detectPairs(team, ['members'], rowsByType), 'members', 'Principal', 'displayName', 'exact');
    expect(p).toMatchObject({ values: 3, unique: 1, multiple: 1, none: 1, uniquePct: 33 }); // Ann unique; two Bob Joneses; Nobody none
  });

  it('a prefix probe finds the plain and the admin account: several matches, not unique', () => {
    expect(find(pairs, 'email', 'Principal', 'email', 'prefix')).toMatchObject({ unique: 1, multiple: 1, none: 1, values: 3, uniquePct: 33 });
  });

  it('a duplicate display name makes the name match multiple', () => {
    expect(find(pairs, 'displayName', 'Principal', 'displayName', 'name')).toMatchObject({ unique: 2, multiple: 1, none: 1 });
  });

  it('matches a code column to employeeId', () => {
    expect(find(pairs, 'code', 'Principal', 'employeeId', 'exact')).toMatchObject({ unique: 3, uniquePct: 75, suggestedWeight: 95 });
  });

  it('drops pairs without a single unique hit', () => {
    expect(find(pairs, 'code', 'Resource', 'externalId', 'exact')).toBeUndefined();
    expect(pairs.every(p => p.unique > 0)).toBe(true);
  });

  it('sorts by uniquePct desc, then by suggested weight', () => {
    const pct = pairs.map(p => p.uniquePct);
    expect(pct).toEqual([...pct].sort((a, b) => b - a));
    expect(pairs[0]).toMatchObject({ attribute: 'code', targetField: 'employeeId' });
    const fifty = pairs.filter(p => p.uniquePct === 50).map(p => p.suggestedWeight);
    expect(fifty).toEqual([...fifty].sort((a, b) => b - a));
  });

  it('handles no entities', () => {
    expect(detectPairs(undefined, ['displayName'], rowsByType)).toEqual([]);
  });

  it('a fuzzy probe against another list finds what exact misses', () => {
    const rows = new Map([['OrgEntity', [
      { id: 'c1', displayName: 'Contoso B.V.', entityType: 'Customer' },
      { id: 'c2', displayName: 'Fabrikam', entityType: 'Customer' },
    ]]]);
    const sheet = ['Contoso', 'Fabrikam', 'Northwind', ''].map(c => ({ entityType: 'Timesheet', displayName: 'r', attributes: { customer: c } }));
    const out = detectPairs(sheet, ['customer'], rows);
    expect(find(out, 'customer', 'OrgEntity', 'displayName', 'fuzzy')).toMatchObject({ unique: 2, none: 1, values: 3, uniquePct: 67, suggestedWeight: 100 });
    expect(find(out, 'customer', 'OrgEntity', 'displayName', 'exact')).toMatchObject({ unique: 1, none: 2, values: 3 });
  });
});

describe('detectLinks', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(async (sql) => ({ rows: sql.includes('"Principals"') ? principals : [] }));
  });

  it('loads every target type with its whitelisted fields and scores the attributes the recipe maps', async () => {
    const def = { type: 'Person', nameColumn: 'Name', attributes: [{ column: 'Mail', name: 'email' }] };
    const pairs = await detectLinks([...people, { entityType: 'Project', displayName: 'Atlas', attributes: {} }], 'Person', def);
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls.map(c => c[0])).toEqual([
      'SELECT "id", "displayName", "email", "employeeId", "principalType" FROM "Principals" WHERE "deletedAt" IS NULL',
      'SELECT "id", "displayName", "email", "employeeId" FROM "Identities"',
      'SELECT "id", "displayName", "mail", "externalId" FROM "Resources" WHERE "deletedAt" IS NULL AND ("resourceType" IS NULL OR "resourceType" NOT IN (\'GroupOwnership\',\'ServicePrincipalOwnership\',\'ApplicationOwnership\',\'ResourceOwnership\'))',
      'SELECT "id", "displayName" FROM "Contexts"',
      'SELECT "id", "displayName", "entityType" FROM "OrgEntities" WHERE "status" = \'accepted\' AND "validTo" IS NULL',
    ]);
    expect(new Set(pairs.map(p => p.attribute))).toEqual(new Set(['displayName', 'email'])); // `code` is not mapped
  });

  it('reads nothing when no entity has the type', async () => {
    expect(await detectLinks(people, 'Project', { type: 'Project', nameColumn: 'P' })).toEqual([]);
    expect(await detectLinks(undefined, 'Project', { type: 'Project', nameColumn: 'P' })).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('entitiesFromRows', () => {
  const def = { type: 'Person', nameColumn: 'Owner', keyColumn: 'Mail', attributes: [{ column: 'Mail', name: 'email' }, { column: 'Dept' }] };

  it('one entity per row with a name and a key, first row wins on a duplicate key (case-insensitive)', () => {
    const out = entitiesFromRows([
      { Owner: ' Ann Smith ', Mail: 'ann@contoso.com', Dept: 'Finance' },
      { Owner: 'Ann S.', Mail: 'ANN@contoso.com ', Dept: 'HR' },
      { Owner: '', Mail: 'x@contoso.com' },
      { Owner: 'No Key', Mail: '  ' },
      { Owner: 'Bob', Mail: 'bob@contoso.com' },
    ], def);
    expect(out).toEqual([
      { entityType: 'Person', displayName: 'Ann Smith', canonicalKey: 'ann@contoso.com', attributes: { email: 'ann@contoso.com', Dept: 'Finance' } },
      { entityType: 'Person', displayName: 'Bob', canonicalKey: 'bob@contoso.com', attributes: { email: 'bob@contoso.com', Dept: null } },
    ]);
  });

  it('keys on the name column when there is no key column', () => {
    const out = entitiesFromRows([{ P: 'Atlas' }, { P: 'atlas' }, { P: 'Borealis' }], { type: 'Project', nameColumn: 'P' });
    expect(out.map(e => e.displayName)).toEqual(['Atlas', 'Borealis']);
    expect(out[0].attributes).toEqual({});
  });

  it('handles no rows', () => {
    expect(entitiesFromRows(undefined, def)).toEqual([]);
    expect(entitiesFromRows([null], def)).toEqual([]);
  });
});
