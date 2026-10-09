import { describe, it, expect } from 'vitest';
import { applyRecipe, summarizeApplied, entityKey, splitEmails, splitSharePointLookup, splitValues } from './applyRecipe.js';
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

describe('applyRecipe — several e-mail addresses in one cell', () => {
  const byMail = normalizeRecipe({
    version: 1,
    entities: [
      { type: 'Project', nameColumn: 'Project' },
      { type: 'Person', nameColumn: 'Owner', keyColumn: 'Mail', attributes: [{ column: 'Dept' }] },
      { type: 'Contact', nameColumn: 'Mail' },
    ],
    relations: [{ predicate: 'owner', from: 'Project', to: 'Person' }, { predicate: 'contact', from: 'Contact', to: 'Project' }],
  });

  it('makes one instance per address, pairs names that split the same way, and relates each', () => {
    const out = applyRecipe([{ Project: 'Atlas', Owner: 'Ann; Bob', Mail: 'Ann@contoso.com; bob@contoso.com', Dept: 'IT' }], byMail);
    expect(out.entities.filter(e => e.entityType === 'Person')).toEqual([
      { entityType: 'Person', displayName: 'Ann', canonicalKey: 'ann@contoso.com', attributes: { Dept: 'IT' }, sourceLocator: 'row:1', row: 1 },
      { entityType: 'Person', displayName: 'Bob', canonicalKey: 'bob@contoso.com', attributes: { Dept: 'IT' }, sourceLocator: 'row:1', row: 1 },
    ]);
    // name column = key column: the address is the name
    expect(out.entities.filter(e => e.entityType === 'Contact').map(e => [e.displayName, e.canonicalKey]))
      .toEqual([['Ann@contoso.com', 'ann@contoso.com'], ['bob@contoso.com', 'bob@contoso.com']]);
    expect(out.relations.map(r => `${r.predicate}:${r.fromKey}>${r.toKey}`)).toEqual([
      'owner:atlas>ann@contoso.com', 'owner:atlas>bob@contoso.com',
      'contact:ann@contoso.com>atlas', 'contact:bob@contoso.com>atlas',
    ]);
    expect(out.issues).toEqual([]);
  });

  it('uses each address as the name when the names do not split into as many parts', () => {
    const out = applyRecipe([{ Project: 'Atlas', Owner: 'Team Atlas', Mail: 'ann@contoso.com,bob@contoso.com' }], byMail);
    expect(out.entities.filter(e => e.entityType === 'Person').map(e => e.displayName)).toEqual(['ann@contoso.com', 'bob@contoso.com']);
  });

  it('does not split a key that is not a list of addresses', () => {
    expect(splitEmails('Smith, Ann')).toEqual(['Smith, Ann']);
    expect(splitEmails('ann@contoso.com; Bob')).toEqual(['ann@contoso.com; Bob']);
    expect(splitEmails('ann@contoso.com')).toEqual(['ann@contoso.com']);
    expect(splitEmails('ann@contoso.com;;bob@contoso.com;')).toEqual(['ann@contoso.com', 'bob@contoso.com']);
    const out = applyRecipe([{ Project: 'Atlas', Owner: 'Smith, Ann', Mail: 'Smith, Ann' }], byMail);
    expect(out.entities.filter(e => e.entityType === 'Person').map(e => e.canonicalKey)).toEqual(['smith, ann']);
  });
});

describe('applyRecipe — a SharePoint lookup cell ("Name;#id;#Name;#id")', () => {
  const recipe = normalizeRecipe({
    version: 1,
    entities: [{ type: 'Customer', nameColumn: 'Title' }, { type: 'TeamMember', nameColumn: 'Team' }],
    relations: [{ predicate: 'team', from: 'Customer', to: 'TeamMember' }],
  });

  it('splits the lookup into one person per name, dropping the item ids', () => {
    expect(splitSharePointLookup('Ann Example;#27;#Bob Example;#16')).toEqual(['Ann Example', 'Bob Example']);
    expect(splitSharePointLookup('Ann Example;#27')).toEqual(['Ann Example']);
    expect(splitSharePointLookup('Ann Example')).toBeNull();
    expect(splitSharePointLookup(';#27')).toBeNull();
    expect(splitValues('a@contoso.com; b@contoso.com')).toEqual(['a@contoso.com', 'b@contoso.com']);
    expect(splitValues('Ann; Bob')).toEqual(['Ann; Bob']);
  });

  it('makes one TeamMember per name on the row, each related to the customer, de-duplicated across rows', () => {
    const out = applyRecipe([
      { Title: 'Contoso Bank', Team: 'Ann Example;#27;#Bob Example;#16' },
      { Title: 'Northwind', Team: 'Bob Example;#16' },
      { Title: 'Fabrikam', Team: '' },
    ], recipe);
    const members = out.entities.filter(e => e.entityType === 'TeamMember');
    expect(members.map(e => [e.displayName, e.canonicalKey, e.row])).toEqual([['Ann Example', 'ann example', 1], ['Bob Example', 'bob example', 1]]);
    expect(out.relations.map(r => `${r.fromKey}>${r.toKey}`)).toEqual(['contoso bank>ann example', 'contoso bank>bob example', 'northwind>bob example']);
    // an empty team cell is no instance; the relation reports the row that has no member
    expect(out.issues.map(i => `${i.kind}:${i.row}`)).toEqual(['missingSide:3']);
  });

  it('exposes the name under the analyst\'s own attribute name when the definition asks for it', () => {
    const named = normalizeRecipe({ version: 1, entities: [{ type: 'Customer', nameColumn: 'Title', nameAttribute: 'klant', attributes: [{ column: 'Team' }] }], relations: [] });
    const out = applyRecipe([{ Title: 'Contoso Bank', Team: 'Ann Example;#27' }], named);
    expect(out.entities[0]).toMatchObject({ displayName: 'Contoso Bank', attributes: { klant: 'Contoso Bank', Team: 'Ann Example;#27' } });
    const plain = applyRecipe([{ Title: 'Contoso Bank', Team: '' }], recipe);
    expect(Object.keys(plain.entities[0].attributes)).toEqual([]);
  });

  it('strips the id from a single-value lookup used as a name', () => {
    const out = applyRecipe([{ Title: 'Contoso Bank', Team: 'Ann Example;#27' }], recipe);
    expect(out.entities.find(e => e.entityType === 'TeamMember')).toMatchObject({ displayName: 'Ann Example', canonicalKey: 'ann example' });
  });
});

describe('applyRecipe — a composite key (a timesheet)', () => {
  const recipe = normalizeRecipe({
    version: 1,
    entities: [{
      type: 'Uren', nameColumn: 'Klant', keyColumns: ['Maand', 'Medewerker', 'Klant'], nameAttribute: 'klant',
      attributes: [{ column: 'Maand', name: 'maand' }, { column: 'Medewerker', name: 'medewerker' }, { column: 'Uren', name: 'uren' }],
    }],
    relations: [],
  });

  it('one instance per row, keyed on the key cells joined with " | ", lowercased', () => {
    const out = applyRecipe([
      { Maand: 'Jan', Medewerker: 'Ann Example', Klant: 'Contoso', Uren: '8,5' },
      { Maand: 'Jan', Medewerker: 'Bob Example', Klant: 'Contoso', Uren: '4,0' },
    ], recipe);
    expect(out.entities.map(e => [e.displayName, e.canonicalKey, e.sourceLocator, e.row])).toEqual([
      ['Contoso', 'jan | ann example | contoso', 'row:1', 1],
      ['Contoso', 'jan | bob example | contoso', 'row:2', 2],
    ]);
    expect(out.entities[0].attributes).toEqual({ maand: 'Jan', medewerker: 'Ann Example', uren: '8,5', klant: 'Contoso' });
    expect(out.issues).toEqual([]);
  });

  it('never splits a key cell that holds several values: the row is one instance', () => {
    const out = applyRecipe([{ Maand: 'Jan', Medewerker: 'Ann Example;#1;#Bob Example;#2', Klant: 'a@contoso.com; b@contoso.com', Uren: '1,0' }], recipe);
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]).toMatchObject({
      displayName: 'a@contoso.com; b@contoso.com',
      canonicalKey: 'jan | ann example;#1;#bob example;#2 | a@contoso.com; b@contoso.com',
    });
  });

  it('a partly empty key still identifies the row; an all-empty key leaves it out with the columns named', () => {
    const plain = normalizeRecipe({ version: 1, entities: [{ type: 'Uren', nameColumn: 'Klant', keyColumns: ['Maand', 'Medewerker'] }], relations: [] });
    const out = applyRecipe([
      { Maand: '', Medewerker: 'Ann Example', Klant: 'Contoso' },
      { Maand: ' ', Medewerker: '', Klant: 'Fabrikam' },
    ], plain);
    expect(out.entities.map(e => e.canonicalKey)).toEqual([' | ann example']);
    expect(out.entities[0].attributes).toEqual({});
    expect(out.issues).toEqual([{
      kind: 'emptyKey', entityType: 'Uren', row: 2,
      detail: 'Uren "Fabrikam" has no value in key column "Maand, Medewerker" and is left out.',
    }]);
  });

  it('the same composite key twice is a duplicate, merged like any other', () => {
    const out = applyRecipe([
      { Maand: 'Jan', Medewerker: 'Ann Example', Klant: 'Contoso', Uren: '1,0' },
      { Maand: 'jan', Medewerker: 'ANN EXAMPLE', Klant: 'contoso', Uren: '2,0' },
    ], recipe);
    expect(out.entities).toHaveLength(1);
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
