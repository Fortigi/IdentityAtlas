import { describe, it, expect } from 'vitest';
import { emailPrefix, heuristicProposal, looksLikeGroupNames, personNameColumn, usableColumns, MAX_NOTES } from './heuristic.js';
import { validateLinkRules, validateRecipe } from '../contracts.js';

// A column profile as import/profileColumns.js produces it.
let nextIndex = 0;
function col(name, shape, { rows = 100, nonEmpty = rows, distinct = nonEmpty, samples = [] } = {}) {
  return { name, index: nextIndex++, nonEmpty, distinct, uniqueness: nonEmpty ? distinct / nonEmpty : 0, shape, samples, duplicates: nonEmpty - distinct };
}
function profile(...cols) { nextIndex = 0; return cols.map(f => f()); }
const c = (...args) => () => col(...args);

function expectValid(result, columns) {
  expect(validateRecipe(result.recipe, columns.map(x => x.name))).toEqual({ ok: true, errors: [] });
  expect(validateLinkRules(result.linkRules, result.recipe)).toEqual({ ok: true, errors: [] });
}
const entity = (result, type) => result.recipe.entities.find(e => e.type === type);
const rule = (result, type) => result.linkRules.find(r => r.entityType === type);
const signalsOf = (r) => r.signals.map(s => `${s.attribute}>${s.targetField}:${s.type}:${s.weight}`);

describe('heuristicProposal — a project list with an owner', () => {
  const columns = profile(
    c('ProjectCode', 'text', { samples: ['P-001', 'P-002'] }),
    c('ProjectName', 'text', { distinct: 98, samples: ['Website relaunch', 'Data platform'] }),
    c('Budget', 'number', { distinct: 40 }),
    c('OwnerName', 'text', { distinct: 30 }),
    c('OwnerEmail', 'email', { distinct: 30, samples: ['a.jansen@contoso.com'] }),
  );
  const result = heuristicProposal({ fileName: 'Projects.xlsx', columns });

  it('proposes Project keyed on its code and named by its name column, with the rest as attributes', () => {
    expect(entity(result, 'Project')).toEqual({
      type: 'Project', keyColumn: 'ProjectCode', nameColumn: 'ProjectName', attributes: [{ column: 'Budget', name: 'budget' }],
    });
  });

  it('turns the e-mail column into an Owner named by its sibling, related by "owner"', () => {
    expect(entity(result, 'Owner')).toEqual({
      type: 'Owner', keyColumn: 'OwnerName', nameColumn: 'OwnerName', attributes: [{ column: 'OwnerEmail', name: 'email' }],
    });
    expect(result.recipe.relations).toEqual([{ predicate: 'owner', from: 'Project', to: 'Owner' }]);
  });

  it('matches the owner to accounts on e-mail and name, and does not match projects to groups', () => {
    expect(result.linkRules).toHaveLength(1);
    expect(rule(result, 'Owner').targetType).toBe('Principal');
    expect(rule(result, 'Owner').threshold).toBe(50);
    expect(signalsOf(rule(result, 'Owner'))).toEqual(['email>email:exact:90', 'displayName>displayName:name:60']);
  });

  it('explains each decision in a sentence', () => {
    expect(result.notes).toEqual([
      'ProjectCode is unique on every row, so it is the key of Project, and ProjectName is its name.',
      'OwnerEmail looks like an e-mail address, so Owner is a person named by OwnerName.',
    ]);
    expectValid(result, columns);
  });
});

describe('heuristicProposal — roles, collisions and groups', () => {
  it('types each person by its role word, numbering a repeated role and using Person otherwise', () => {
    const columns = profile(
      c('Code', 'text'), c('Titel', 'text'),
      c('Owner', 'text', { distinct: 20 }), c('OwnerEmail', 'email', { distinct: 20 }),
      c('Owner Mail', 'email', { distinct: 20 }),
      c('Requester e-mail', 'email', { distinct: 50 }),
      c('E-mailadres beheerder', 'email', { distinct: 5 }),
    );
    const result = heuristicProposal({ fileName: 'apps.csv', columns });
    expect(result.recipe.entities.map(e => [e.type, e.nameColumn])).toEqual([
      ['App', 'Titel'], ['Owner', 'Owner'], ['Owner2', 'Owner Mail'], ['Person', 'Requester e-mail'], ['Beheerder', 'E-mailadres beheerder'],
    ]);
    expect(result.recipe.relations.map(r => `${r.predicate}>${r.to}`)).toEqual(['owner>Owner', 'owner>Owner2', 'requester>Person', 'beheerder>Beheerder']);
    // An entity named by its own e-mail address is matched on the address only.
    expect(signalsOf(rule(result, 'Owner2'))).toEqual(['email>email:exact:90']);
    expect(signalsOf(rule(result, 'Owner'))).toHaveLength(2);
    expectValid(result, columns);
  });

  it('keeps the primary type when a person role has the same name', () => {
    const columns = profile(c('Naam', 'text'), c('OwnerEmail', 'email'));
    const result = heuristicProposal({ fileName: 'owners.xlsx', columns });
    expect(result.recipe.entities.map(e => e.type)).toEqual(['Owner', 'Owner2']);
    expect(result.recipe.relations).toEqual([{ predicate: 'owner', from: 'Owner', to: 'Owner2' }]);
    expectValid(result, columns);
  });

  it('matches the primary to groups when its names look like group names', () => {
    const columns = profile(
      c('Group', 'text', { samples: ['SG_Finance_Read', 'GG-HR-All', 'Plain name'] }),
      c('ManagerEmail', 'email', { distinct: 10 }),
    );
    const result = heuristicProposal({ fileName: 'Group owners.xlsx', columns });
    expect(result.linkRules.map(r => `${r.entityType}>${r.targetType}`)).toEqual(['GroupOwner>Resource', 'Manager>Principal']);
    expect(signalsOf(rule(result, 'GroupOwner'))).toEqual(['displayName>displayName:exact:80', 'displayName>displayName:token:50']);
    expect(result.notes).toContain('The values of Group look like group names, so GroupOwner is matched to groups.');
    expectValid(result, columns);
  });
});

describe('heuristicProposal — degenerate profiles', () => {
  it('one text column: one Item entity, no relations, no rules', () => {
    const columns = profile(c('Whatever', 'text', { distinct: 3 }));
    const result = heuristicProposal({ columns });
    expect(result.recipe).toEqual({ version: 1, entities: [{ type: 'Item', nameColumn: 'Whatever', keyColumn: 'Whatever', attributes: [] }], relations: [] });
    expect(result.linkRules).toEqual([]);
    expect(result.notes).toEqual(['No column is unique on every row, so Item is identified by Whatever.']);
    expectValid(result, columns);
  });

  it('no unique column: no keyColumn chosen, the name header names it', () => {
    const columns = profile(c('Category', 'text', { distinct: 4 }), c('Description', 'text', { distinct: 80 }), c('Flag', 'boolean', { distinct: 2 }));
    const result = heuristicProposal({ fileName: 'x.csv', columns });
    const e = result.recipe.entities[0];
    expect(e.nameColumn).toBe('Description');
    expect(e.keyColumn).toBe('Description'); // normalizeRecipe defaults the key to the name
    expect(e.attributes.map(a => a.column)).toEqual(['Category', 'Flag']);
    expectValid(result, columns);
  });

  it('a unique column that is too empty is not a key; a numeric ID is when no text column qualifies', () => {
    const sparse = profile(c('Ref', 'text', { nonEmpty: 50, distinct: 50 }), c('Id', 'number'), c('Label', 'text', { distinct: 60 }));
    const r = heuristicProposal({ columns: sparse, rowCount: 100 });
    expect(r.recipe.entities[0].keyColumn).toBe('Id');
    expect(r.recipe.entities[0].nameColumn).toBe('Id');
    expect(r.recipe.entities[0].attributes.map(a => a.name)).toEqual(['ref', 'label']);
    expectValid(r, sparse);
  });

  it('just under the uniqueness and fill limits is not a key, exactly on them is', () => {
    const under = profile(c('A', 'text', { distinct: 94 }), c('B', 'text', { nonEmpty: 89, distinct: 89 }));
    expect(heuristicProposal({ columns: under, rowCount: 100 }).recipe.entities[0].attributes).toHaveLength(1);
    expect(heuristicProposal({ columns: under, rowCount: 100 }).notes[0]).toMatch(/^No column is unique/);
    const on = profile(c('A', 'text', { distinct: 95 }), c('B', 'text', { nonEmpty: 90, distinct: 90 }));
    expect(heuristicProposal({ columns: on, rowCount: 100 }).recipe.entities[0].keyColumn).toBe('A');
    expect(heuristicProposal({ columns: [on[1]], rowCount: 100 }).recipe.entities[0].keyColumn).toBe('B');
  });

  it('only an e-mail column: a single Person, nothing else', () => {
    const columns = profile(c('Email', 'email'));
    const result = heuristicProposal({ fileName: 'people.csv', columns });
    expect(result.recipe.entities).toEqual([{ type: 'Person', nameColumn: 'Email', keyColumn: 'Email', attributes: [{ column: 'Email', name: 'email' }] }]);
    expect(result.recipe.relations).toEqual([]);
    expect(result.notes).toEqual(['Email looks like an e-mail address, so Person is a person.']);
    expectValid(result, columns);
  });

  it('headers that camelCase to nothing or to a reserved name still get unique attribute names', () => {
    const columns = profile(c('Code', 'text'), c('€', 'text', { distinct: 2 }), c('Display name', 'text', { distinct: 2 }), c('display_name', 'text', { distinct: 2 }));
    const result = heuristicProposal({ columns });
    expect(result.recipe.entities[0].nameColumn).toBe('Display name');
    expect(result.recipe.entities[0].attributes.map(a => a.name)).toEqual(['column2', 'displayName2']);
    expectValid(result, columns);
  });

  it('more e-mail columns than entity slots: the rest stay attributes of the primary', () => {
    const columns = profile(c('Key', 'text'), ...Array.from({ length: 22 }, (_, i) => c(`Contact${i}Email`, 'email', { distinct: 5 })));
    const result = heuristicProposal({ columns });
    expect(result.recipe.entities).toHaveLength(20);
    expect(result.recipe.entities[0].attributes.map(a => a.column)).toEqual(['Contact19Email', 'Contact20Email', 'Contact21Email']);
    expect(result.notes).toHaveLength(MAX_NOTES);
    expectValid(result, columns);
  });

  it('ignores columns without a name, and refuses a profile with none', () => {
    const columns = [{ name: '' }, { name: '  ' }, null, { name: 'Real', shape: 'text', nonEmpty: 3, distinct: 3, uniqueness: 1 }];
    expect(heuristicProposal({ columns }).recipe.entities[0].nameColumn).toBe('Real');
    expect(() => heuristicProposal({ columns: [] })).toThrow('The list has no named columns');
    expect(() => heuristicProposal({ columns: 'nope' })).toThrow('no named columns');
    expect(() => heuristicProposal()).toThrow('no named columns');
  });

  it('survives missing counts and indexes in the profile', () => {
    const columns = [{ name: 'A' }, { name: 'B', shape: 'email' }, { name: 'BName' }];
    const result = heuristicProposal({ columns });
    expect(result.recipe.entities.map(e => [e.type, e.nameColumn])).toEqual([['Item', 'A'], ['Person', 'BName']]);
    expectValid(result, columns);
  });
});

describe('helpers', () => {
  it('emailPrefix strips the e-mail words wherever they stand', () => {
    expect(emailPrefix('OwnerEmail')).toBe('Owner');
    expect(emailPrefix('Business Owner E-mail Address')).toBe('Business Owner');
    expect(emailPrefix('E-mailadres eigenaar')).toBe('eigenaar');
    expect(emailPrefix('UPN')).toBe('');
  });

  it('personNameColumn picks the nearest sibling with the same prefix', () => {
    const free = [{ name: 'OwnerName', index: 1 }, { name: 'Other', index: 4 }, { name: 'Owner', index: 6 }, { name: 'naam owner', index: 9 }];
    expect(personNameColumn({ name: 'OwnerEmail', index: 7 }, 'Owner', free).name).toBe('Owner');
    expect(personNameColumn({ name: 'OwnerEmail', index: 2 }, 'Owner', free).name).toBe('OwnerName');
    expect(personNameColumn({ name: 'OwnerEmail', index: 10 }, 'Owner', free).name).toBe('naam owner');
    expect(personNameColumn({ name: 'Email', index: 0 }, '', free)).toBeNull();
    expect(personNameColumn({ name: 'XEmail', index: 0 }, 'X', free)).toBeNull();
  });

  it('looksLikeGroupNames needs at least half of the non-empty samples to look like groups', () => {
    expect(looksLikeGroupNames(['SG-Finance', 'Plain'])).toBe(true);
    expect(looksLikeGroupNames(['AAD_x', 'Plain', 'Other'])).toBe(false);
    expect(looksLikeGroupNames(['dl-sales', 'az-ops', 'Plain'])).toBe(true);
    expect(looksLikeGroupNames(['SGX', 'Plain'])).toBe(false);
    expect(looksLikeGroupNames(['', '  ', 42])).toBe(false);
    expect(looksLikeGroupNames(undefined)).toBe(false);
  });

  it('usableColumns keeps named columns in order and fills a missing index', () => {
    expect(usableColumns([{ name: 'A', index: 5 }, { name: '' }, { name: 'B' }]).map(x => [x.name, x.index])).toEqual([['A', 5], ['B', 1]]);
    expect(usableColumns(undefined)).toEqual([]);
  });
});
