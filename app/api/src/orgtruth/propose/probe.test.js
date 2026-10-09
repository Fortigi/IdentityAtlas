import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');

import { query } from '../../db/connection.js';
import {
  buildTargets, probeColumns, findCompositeKey, loadProbeTargets, MAX_PROBE, ORG_SIMILARITY,
} from './probe.js';

beforeEach(() => { query.mockReset(); });

const people = [
  { displayName: 'Ann Example' },
  { displayName: 'Example, Bob' },
  { displayName: null, givenName: 'Cas', surname: 'Sample' },
];
const resources = [{ displayName: 'SG_Finance' }, { displayName: null }];
const orgEntities = [
  { displayName: 'Contoso B.V.', entityType: 'Customer' },
  { displayName: 'Fabrikam', entityType: 'Customer' },
  { displayName: 'Northwind Traders', entityType: 'Supplier' },
  { displayName: 'Verne Business Excellence', entityType: 'Project' },
];
const targets = buildTargets(people, resources, orgEntities);

describe('buildTargets', () => {
  it('indexes people by exact name and by full-name key, resources by name, org entities by word', () => {
    expect([...targets.personNames]).toEqual(['ann example', 'example, bob']);
    expect([...targets.personKeys]).toEqual(['ann|example', 'bob|example', 'cas|sample']);
    expect([...targets.resourceNames]).toEqual(['sg_finance']);
    expect([...targets.orgByWord.keys()]).toEqual(['contoso', 'fabrikam', 'northwind', 'traders', 'verne', 'business', 'excellence']);
    expect(targets.orgByWord.get('contoso')).toEqual([orgEntities[0]]);
  });
  it('indexes no one-letter word and no entity without a name', () => {
    const t = buildTargets([], [], [{ displayName: 'X Ray', entityType: 'T' }, { displayName: null, entityType: 'T' }]);
    expect([...t.orgByWord.keys()]).toEqual(['ray']);
  });
});

describe('probeColumns', () => {
  const rows = [
    { Who: 'Ann Example', Customer: 'Contoso', Group: 'SG_Finance', Mixed: 'Bob Example;#1;#Nobody Known;#2' },
    { Who: 'Bob Example', Customer: 'Fabrikam B.V.', Group: 'SG_HR', Mixed: '' },
    { Who: 'A. Example', Customer: 'Northwind', Group: '', Mixed: '  ' },
    { Who: 'Ann Example', Customer: 'Verne', Group: 'SG_Finance', Mixed: null },
  ];
  const out = probeColumns(['Who', { name: 'Customer' }, 'Group', 'Mixed', 'Missing'], rows, targets);

  it('people: a share of the distinct values, exact or by full name ("A. Example" is no full name)', () => {
    expect(out.Who).toEqual({ values: 3, people: 0.67, resources: 0, orgEntities: 0, orgEntityTypes: [] });
  });
  it('org entities: fuzzy at 0.8 or more, their types most frequent first', () => {
    expect(ORG_SIMILARITY).toBe(0.8);
    // Contoso 1, Fabrikam 1, Verne ⊂ "Verne Business Excellence" 0.8 → counts; Northwind ⊂ "Northwind Traders" 0.85 → counts
    expect(out.Customer).toMatchObject({ values: 4, people: 0, resources: 0, orgEntities: 1 });
    expect(out.Customer.orgEntityTypes).toEqual(['Customer', 'Supplier', 'Project']);
  });
  it('resources: exact display names only', () => {
    expect(out.Group).toMatchObject({ values: 2, resources: 0.5, people: 0 });
  });
  it('splits a cell like the link engine (SharePoint lookups) and skips empty cells', () => {
    expect(out.Mixed).toMatchObject({ values: 2, people: 0.5 });
  });
  it('a column without values is all zeros', () => {
    expect(out.Missing).toEqual({ values: 0, people: 0, resources: 0, orgEntities: 0, orgEntityTypes: [] });
  });
  it('an org entity below the similarity floor does not count', () => {
    const t = buildTargets([], [], [{ displayName: 'Verne Business Excellence Group', entityType: 'P' }]);
    // "Verne" in a 3-word name ("group" is noise): 0.8 counts; in a 4-word one: 0.75 does not
    const t2 = buildTargets([], [], [{ displayName: 'Verne Business Excellence Nederland', entityType: 'P' }]);
    expect(probeColumns(['C'], [{ C: 'Verne' }], t).C.orgEntities).toBe(1);
    expect(probeColumns(['C'], [{ C: 'Verne' }], t2).C.orgEntities).toBe(0);
  });
  it('keeps the best match of a value: the more similar entity decides its type', () => {
    const t = buildTargets([], [], [
      { displayName: 'Contoso Digital', entityType: 'Project' },
      { displayName: 'Contoso', entityType: 'Customer' },
    ]);
    expect(probeColumns(['C'], [{ C: 'Contoso' }], t).C.orgEntityTypes).toEqual(['Customer']);
  });
  it(`probes at most ${MAX_PROBE} distinct values`, () => {
    expect(MAX_PROBE).toBe(200);
    const many = Array.from({ length: MAX_PROBE + 5 }, (_, i) => ({ C: `v${i}` }));
    many.push({ C: 'Ann Example' });
    expect(probeColumns(['C'], many, targets).C).toMatchObject({ values: 200, people: 0 });
  });
});

describe('findCompositeKey', () => {
  const col = (name, shape = 'text', samples = []) => ({ name, shape, nonEmpty: 3, samples });
  const rows = [
    { Year: '2026', Month: 'jan', Person: 'Ann', Customer: 'Contoso', Hours: '8,5' },
    { Year: '2026', Month: 'jan', Person: 'Bob', Customer: 'Contoso', Hours: '8,5' },
    { Year: '2026', Month: 'feb', Person: 'Ann', Customer: 'Contoso', Hours: '4,0' },
    { Year: '2026', Month: 'feb', Person: 'Ann', Customer: 'Fabrikam', Hours: '2,0' },
  ];
  const cols = [col('Year', 'number', ['2026']), col('Month'), col('Person'), col('Customer'), col('Hours', 'number', ['8,5', '4,0'])];

  it('the smallest unique combination, in file order', () => {
    expect(findCompositeKey(cols, rows)).toEqual(['Month', 'Person', 'Customer']);
    expect(findCompositeKey(cols, rows.slice(0, 3))).toEqual(['Month', 'Person']);
  });
  it('a decimal number column is a measure, never part of the key; a whole number is', () => {
    // Person + Hours would be unique on these rows, but Hours measures
    const r = [{ Person: 'Ann', Hours: '1.5' }, { Person: 'Ann', Hours: '2.5' }];
    expect(findCompositeKey([col('Person'), col('Hours', 'number', ['1.5'])], r)).toBeNull();
    expect(findCompositeKey([col('Person'), col('Week', 'number', ['12'])], [{ Person: 'Ann', Week: '12' }, { Person: 'Ann', Week: '13' }])).toEqual(['Person', 'Week']);
  });
  it('null when no combination of up to four columns is unique, or nothing is usable', () => {
    const dup = [...rows, rows[0]];
    expect(findCompositeKey(cols, dup)).toBeNull();
    expect(findCompositeKey([col('Person')], rows)).toBeNull();
    expect(findCompositeKey([{ ...col('A'), nonEmpty: 0 }, { ...col('B'), nonEmpty: 0 }], rows)).toBeNull();
  });
  it('stops at maxSize: a five-column key is not looked for', () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map(n => col(n));
    const r = [
      { A: '1', B: '1', C: '1', D: '1', E: '1' },
      { A: '1', B: '1', C: '1', D: '1', E: '2' },
    ];
    expect(findCompositeKey(five, r)).toEqual(['A', 'E']);
    expect(findCompositeKey(five.slice(0, 4), r)).toBeNull();
    const three = [{ A: '1', B: '1', C: '1' }, { A: '1', B: '1', C: '2' }, { A: '1', B: '2', C: '1' }, { A: '2', B: '1', C: '1' }];
    expect(findCompositeKey(five.slice(0, 3), three)).toEqual(['A', 'B', 'C']);
    expect(findCompositeKey(five.slice(0, 3), three, { maxSize: 2 })).toBeNull();
  });
  it('rows empty on every key column are skipped, compared case-insensitively, and an all-empty list has no key', () => {
    const r = [{ A: 'x', B: '1' }, { A: '', B: '' }, { A: '', B: '' }, { A: 'y', B: '1' }];
    expect(findCompositeKey([col('A'), col('B')], r)).toEqual(['A', 'B']);
    expect(findCompositeKey([col('A'), col('B')], [{ A: 'X', B: '1' }, { A: 'x', B: '1' }])).toBeNull();
    expect(findCompositeKey([col('A'), col('B')], [{ A: '', B: '' }])).toBeNull();
  });
});

describe('loadProbeTargets', () => {
  it('reads human accounts, non-ownership resources and current accepted org entities, and indexes them', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ displayName: 'Ann Example' }] })
      .mockResolvedValueOnce({ rows: [{ displayName: 'SG_Finance' }] })
      .mockResolvedValueOnce({ rows: [{ displayName: 'Contoso', entityType: 'Customer' }] });
    const t = await loadProbeTargets();
    expect(query).toHaveBeenCalledTimes(3);
    const [pSql, pParams] = query.mock.calls[0];
    expect(pSql).toMatch(/FROM "Principals"\s+WHERE "deletedAt" IS NULL AND \("principalType" IS NULL OR "principalType" <> ALL\(\$1::text\[\]\)\)/);
    expect(pParams).toEqual([['ServicePrincipal', 'ManagedIdentity', 'AIAgent']]);
    expect(query.mock.calls[1][0]).toMatch(/FROM "Resources" WHERE "deletedAt" IS NULL\s+AND \("resourceType" IS NULL OR "resourceType" NOT IN \('GroupOwnership'/);
    expect(query.mock.calls[2][0]).toMatch(/FROM "OrgEntities" WHERE "status" = 'accepted' AND "validTo" IS NULL/);
    expect([...t.personNames]).toEqual(['ann example']);
    expect([...t.resourceNames]).toEqual(['sg_finance']);
    expect(t.orgByWord.get('contoso')).toEqual([{ displayName: 'Contoso', entityType: 'Customer' }]);
  });
});
