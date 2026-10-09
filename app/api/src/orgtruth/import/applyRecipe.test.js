import { describe, it, expect } from 'vitest';
import { applyRecipe, summarizeApplied, entityKey } from './applyRecipe.js';
import { normalizeRecipe } from '../contracts.js';

const recipe = normalizeRecipe({
  version: 1,
  entities: [
    { type: 'Project', keyColumn: 'Code', nameColumn: 'Project', attributes: [{ column: 'Budget', name: 'budget' }, { column: 'Phase' }] },
    { type: 'Person', nameColumn: 'Owner', attributes: [{ column: 'Mail', name: 'email' }] },
  ],
  relations: [{ predicate: 'owner', from: 'Project', to: 'Person' }],
});

const row = (Code, Project, Owner, Mail = '', Budget = '', Phase = '') => ({ Code, Project, Owner, Mail, Budget, Phase });

describe('applyRecipe — instances', () => {
  it('makes one instance per definition per row, keyed by the trimmed lower-cased key column', () => {
    const out = applyRecipe([row(' P-1 ', 'Atlas', 'Ann de Vries', 'ann@contoso.com', '1000', 'Build')], recipe);
    expect(out.entities).toEqual([
      { entityType: 'Project', canonicalKey: 'p-1', displayName: 'Atlas', attributes: { budget: '1000', Phase: 'Build' }, sourceLocator: 'row:1', row: 1 },
      { entityType: 'Person', canonicalKey: 'ann de vries', displayName: 'Ann de Vries', attributes: { email: 'ann@contoso.com' }, sourceLocator: 'row:1', row: 1 },
    ]);
    expect(out.relations).toEqual([
      { predicate: 'owner', fromType: 'Project', fromKey: 'p-1', toType: 'Person', toKey: 'ann de vries', sourceLocator: 'row:1', row: 1 },
    ]);
    expect(out.issues).toEqual([]);
  });

  it('trims names and attribute values and leaves blank attributes out', () => {
    const out = applyRecipe([row('P-1', '  Atlas  ', 'Bob', '  ', ' 5 ', '')], recipe);
    expect(out.entities[0]).toMatchObject({ displayName: 'Atlas', attributes: { budget: '5' } });
    expect(out.entities[1].attributes).toEqual({});
  });

  it('skips a definition whose name is blank, without an issue, and keeps the row number of later rows', () => {
    const out = applyRecipe([row('', '', '', ''), row('P-2', 'Beacon', '   ')], recipe);
    expect(out.entities).toEqual([expect.objectContaining({ entityType: 'Project', canonicalKey: 'p-2', sourceLocator: 'row:2', row: 2 })]);
    expect(out.issues).toEqual([
      expect.objectContaining({ kind: 'missingSide', entityType: 'Person', row: 2 }),
    ]);
  });

  it('reports a named entity with a blank key as emptyKey and leaves it out', () => {
    const out = applyRecipe([row('  ', 'Atlas', 'Ann')], recipe);
    expect(out.entities.map(e => e.entityType)).toEqual(['Person']);
    expect(out.issues).toEqual([
      { kind: 'emptyKey', entityType: 'Project', row: 1, detail: 'Project "Atlas" has no value in key column "Code" and is left out.' },
      expect.objectContaining({ kind: 'missingSide', entityType: 'Project', row: 1 }),
    ]);
  });
});

describe('applyRecipe — duplicates', () => {
  it('merges a repeat that agrees silently: same owner on several projects is one person', () => {
    const out = applyRecipe([
      row('P-1', 'Atlas', 'Ann', ''),
      row('P-2', 'Beacon', 'Ann', 'ann@contoso.com'),
      row('P-3', 'Comet', 'Ann', 'ann@contoso.com'),
    ], recipe);
    const people = out.entities.filter(e => e.entityType === 'Person');
    expect(people).toEqual([
      { entityType: 'Person', canonicalKey: 'ann', displayName: 'Ann', attributes: { email: 'ann@contoso.com' }, sourceLocator: 'row:1', row: 1 },
    ]);
    expect(out.relations.map(r => r.fromKey)).toEqual(['p-1', 'p-2', 'p-3']);
    expect(out.issues).toEqual([]);
  });

  it('keeps the first row on a conflicting repeat and reports which fields differ', () => {
    const out = applyRecipe([
      row('P-1', 'Atlas', 'Ann', '', '100', ''),
      row('p-1', 'Atlas v2', 'Ann', '', '200', 'Run'),
    ], recipe);
    const projects = out.entities.filter(e => e.entityType === 'Project');
    expect(projects).toEqual([
      expect.objectContaining({ displayName: 'Atlas', attributes: { budget: '100', Phase: 'Run' }, row: 1 }),
    ]);
    expect(out.issues).toEqual([{
      kind: 'duplicateKey', entityType: 'Project', row: 2,
      detail: 'Project "p-1" was already on row 1; this row differs in name, budget; the first row is kept.',
    }]);
  });

  it('is case-insensitive on the key but treats a different name with the same key as a conflict', () => {
    const out = applyRecipe([row('A', 'One', 'X'), row('a', 'one', 'X')], recipe);
    expect(out.entities).toHaveLength(2);
    expect(out.issues).toEqual([expect.objectContaining({ kind: 'duplicateKey', row: 2, detail: expect.stringContaining('differs in name;') })]);
  });

  it('records a relation once per (predicate, from, to), first row wins', () => {
    const out = applyRecipe([row('P-1', 'Atlas', 'Ann'), row('P-1', 'Atlas', 'Ann'), row('P-1', 'Atlas', 'Bob')], recipe);
    expect(out.relations.map(r => [r.toKey, r.row])).toEqual([['ann', 1], ['bob', 3]]);
  });
});

describe('applyRecipe — relation sides', () => {
  it('reports the missing side by type when only one side is on the row', () => {
    const out = applyRecipe([row('', '', 'Ann'), row('P-1', 'Atlas', '')], recipe);
    expect(out.relations).toEqual([]);
    expect(out.issues).toEqual([
      { kind: 'missingSide', entityType: 'Project', row: 1, detail: 'Row 1 has a Person but no Project, so "owner" (Project → Person) is not recorded for it.' },
      { kind: 'missingSide', entityType: 'Person', row: 2, detail: 'Row 2 has a Project but no Person, so "owner" (Project → Person) is not recorded for it.' },
    ]);
  });

  it('never links an instance to itself when a relation goes from a type to the same type', () => {
    const self = normalizeRecipe({ version: 1, entities: [{ type: 'Team', nameColumn: 'Team' }], relations: [{ predicate: 'partOf', from: 'Team', to: 'Team' }] });
    const out = applyRecipe([{ Team: 'Red' }, { Team: '' }], self);
    expect(out.relations).toEqual([]);
    expect(out.issues).toEqual([]);
  });

  it('handles wide rows: many entity types per row, relations only between the ones present', () => {
    const wide = normalizeRecipe({
      version: 1,
      entities: ['A', 'B', 'C', 'D', 'E'].map(t => ({ type: t, nameColumn: `col${t}` })),
      relations: [
        { predicate: 'ab', from: 'A', to: 'B' }, { predicate: 'cd', from: 'C', to: 'D' },
        { predicate: 'de', from: 'D', to: 'E' }, { predicate: 'ea', from: 'E', to: 'A' },
      ],
    });
    const out = applyRecipe([{ colA: 'a1', colB: 'b1', colC: '', colD: 'd1', colE: 'e1', extra: 'ignored' }], wide);
    expect(out.entities.map(e => `${e.entityType}:${e.canonicalKey}`)).toEqual(['A:a1', 'B:b1', 'D:d1', 'E:e1']);
    expect(out.relations.map(r => `${r.predicate}:${r.fromKey}>${r.toKey}`)).toEqual(['ab:a1>b1', 'de:d1>e1', 'ea:e1>a1']);
    expect(out.issues).toEqual([expect.objectContaining({ kind: 'missingSide', entityType: 'C', row: 1 })]);
  });

  it('copes with rows that lack a mapped column altogether', () => {
    const out = applyRecipe([{ Project: 'Atlas' }, null], recipe);
    expect(out.entities).toEqual([]);
    expect(out.issues).toEqual([expect.objectContaining({ kind: 'emptyKey', entityType: 'Project', row: 1 })]);
  });
});

describe('summarizeApplied', () => {
  it('counts entities, duplicate and empty keys per recipe type, and relations per predicate, zeros included', () => {
    const out = applyRecipe([
      row('P-1', 'Atlas', 'Ann'), row('p-1', 'Other', 'Ann'), row('', 'Nameless', ''), row('P-2', 'Beacon', ''),
    ], recipe);
    expect(summarizeApplied(out, recipe)).toEqual({
      entities: {
        Project: { total: 2, duplicateKeys: 1, emptyKeys: 1 },
        Person: { total: 1, duplicateKeys: 0, emptyKeys: 0 },
      },
      relations: { owner: 1 },
    });
    expect(summarizeApplied({ entities: [], relations: [], issues: [] }, recipe).relations).toEqual({ owner: 0 });
  });
});

describe('entityKey', () => {
  it('cannot collide across type and key boundaries', () => {
    expect(entityKey('a', 'bc')).not.toBe(entityKey('ab', 'c'));
  });
});
