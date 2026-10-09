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
    expect(signalTypesFor('text', 'Resource', 'displayName')).toEqual(['exact', 'token']);
    expect(signalTypesFor('text', 'Context', 'displayName')).toEqual(['exact', 'token']);
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
  });
});

describe('probesFor', () => {
  it('nothing for an all-empty attribute, and only loaded target types', () => {
    expect(probesFor(null, new Map([['Principal', []]]))).toEqual([]);
    const p = probesFor('text', new Map([['Context', []]]));
    expect(p).toEqual([
      { targetType: 'Context', targetField: 'displayName', type: 'exact' },
      { targetType: 'Context', targetField: 'displayName', type: 'token' },
    ]);
  });
});

describe('detectPairs', () => {
  const rowsByType = new Map([['Principal', principals], ['Resource', resources]]);
  const pairs = detectPairs(people, ['displayName', 'email', 'code'], rowsByType);

  it('counts unique, multiple and none per pair over all entities (an empty value is none)', () => {
    expect(find(pairs, 'email', 'Principal', 'email', 'exact')).toEqual({
      attribute: 'email', targetType: 'Principal', targetField: 'email', type: 'exact',
      unique: 2, multiple: 0, none: 2, uniquePct: 50, suggestedWeight: 90,
    });
  });

  it('a prefix probe finds the plain and the admin account: several matches, not unique', () => {
    expect(find(pairs, 'email', 'Principal', 'email', 'prefix')).toMatchObject({ unique: 1, multiple: 1, none: 2, uniquePct: 25 });
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
});

describe('detectLinks', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(async (sql) => ({ rows: sql.includes('"Principals"') ? principals : [] }));
  });

  it('loads every target type with its whitelisted fields and scores the attributes the recipe maps', async () => {
    const def = { type: 'Person', nameColumn: 'Name', attributes: [{ column: 'Mail', name: 'email' }] };
    const pairs = await detectLinks([...people, { entityType: 'Project', displayName: 'Atlas', attributes: {} }], 'Person', def);
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.map(c => c[0])).toEqual([
      'SELECT "id", "displayName", "email", "employeeId", "principalType" FROM "Principals" WHERE "deletedAt" IS NULL',
      'SELECT "id", "displayName", "email", "employeeId" FROM "Identities"',
      'SELECT "id", "displayName", "mail", "externalId" FROM "Resources" WHERE "deletedAt" IS NULL',
      'SELECT "id", "displayName" FROM "Contexts"',
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
