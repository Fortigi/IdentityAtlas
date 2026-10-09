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

  it('matches the owner to accounts on e-mail and name, and the project to resources by name', () => {
    expect(result.linkRules.map(r => `${r.entityType}>${r.targetType}`)).toEqual(['Project>Resource', 'Owner>Principal']);
    expect(rule(result, 'Owner').threshold).toBe(50);
    expect(signalsOf(rule(result, 'Owner'))).toEqual(['email>email:exact:90', 'displayName>displayName:name:60']);
    expect(signalsOf(rule(result, 'Project'))).toEqual(['displayName>displayName:exact:80', 'displayName>displayName:token:50']);
  });

  it('explains each decision in a sentence', () => {
    expect(result.notes).toEqual([
      'ProjectCode is unique on every row, so it is the key of Project, and ProjectName is its name.',
      'OwnerEmail looks like an e-mail address, so Owner is a person named by OwnerName.',
      'Project is also matched to resources by name (ProjectName); the quality step shows whether that finds anything.',
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
  it('one text column: one Item entity, no relations, only the resource rule', () => {
    const columns = profile(c('Whatever', 'text', { distinct: 3 }));
    const result = heuristicProposal({ columns });
    expect(result.recipe).toEqual({ version: 1, entities: [{ type: 'Item', nameColumn: 'Whatever', keyColumn: 'Whatever', attributes: [] }], relations: [] });
    expect(result.linkRules.map(r => `${r.entityType}>${r.targetType}`)).toEqual(['Item>Resource']);
    expect(result.notes[0]).toBe('No column is unique enough to be a key, so Item is identified by Whatever.');
    expectValid(result, columns);
  });

  it('no unique column: no keyColumn chosen, the name header names it', () => {
    const columns = profile(c('Category', 'text', { distinct: 4 }), c('Description', 'text', { distinct: 70 }), c('Flag', 'boolean', { distinct: 2 }));
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
    const under = profile(c('A', 'text', { distinct: 79 }), c('B', 'text', { nonEmpty: 89, distinct: 89 }));
    expect(heuristicProposal({ columns: under, rowCount: 100 }).recipe.entities[0].attributes).toHaveLength(1);
    expect(heuristicProposal({ columns: under, rowCount: 100 }).notes[0]).toMatch(/^No column is unique enough/);
    const on = profile(c('A', 'text', { distinct: 80 }), c('B', 'text', { nonEmpty: 90, distinct: 90 }));
    expect(heuristicProposal({ columns: [on[0]], rowCount: 100 }).recipe.entities[0].keyColumn).toBe('A');
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

describe('heuristicProposal — realistic lists', () => {
  it('a 12-row project list with one duplicate code still keys Project on that code', () => {
    const columns = profile(
      c('Status', 'text', { rows: 12, distinct: 12 }), // fully unique, but its header does not say key
      c('ProjectCode', 'text', { rows: 12, distinct: 11 }),
      c('Omschrijving', 'text', { rows: 12, distinct: 12 }),
      c('Budget', 'number', { rows: 12, distinct: 9 }),
    );
    const result = heuristicProposal({ fileName: 'Projects.xlsx', columns });
    expect(entity(result, 'Project')).toMatchObject({ keyColumn: 'ProjectCode', nameColumn: 'Omschrijving' });
    expect(entity(result, 'Project').attributes.map(a => a.column)).toEqual(['Status', 'Budget']);
    expect(result.notes[0]).toBe('ProjectCode is nearly unique (a few values repeat), so it is the key of Project, and Omschrijving is its name.');
    expectValid(result, columns);
  });

  it('without a key-like header the most unique column wins, the leftmost on a tie', () => {
    const columns = profile(c('Alpha', 'text', { distinct: 85 }), c('Beta', 'number', { distinct: 97 }), c('Gamma', 'text', { distinct: 97 }), c('Flag', 'boolean'));
    expect(heuristicProposal({ columns }).recipe.entities[0].keyColumn).toBe('Beta');
    // A boolean column is never a key, however its counts look.
    const onlyFlag = profile(c('Flag', 'boolean'), c('Note', 'text', { distinct: 10 }));
    expect(heuristicProposal({ columns: onlyFlag }).notes[0]).toMatch(/^No column is unique enough/);
  });

  it('an "OwnerEmail"-only list: an Owner named by its address, linked on e-mail alone', () => {
    const columns = profile(c('OwnerEmail', 'email', { distinct: 40, samples: ['a.jansen@contoso.com'] }));
    const result = heuristicProposal({ fileName: 'Projects.xlsx', columns });
    expect(result.recipe.entities).toEqual([{ type: 'Owner', nameColumn: 'OwnerEmail', keyColumn: 'OwnerEmail', attributes: [{ column: 'OwnerEmail', name: 'email' }] }]);
    expect(result.linkRules).toEqual([{ entityType: 'Owner', targetType: 'Principal', threshold: 50, signals: [
      { name: 'email→email', attribute: 'email', targetField: 'email', type: 'exact', weight: 90, order: 0 },
    ] }]);
    expectValid(result, columns);
  });
});

describe('heuristicProposal — an owner column that holds names, not addresses', () => {
  // A SharePoint-style list: Title, Eigenaar (person names), a few flags and texts.
  const columns = profile(
    c('Title', 'text', { rows: 58, samples: ['Contoso Bank', 'Northwind Finance'] }),
    c('Eigenaar', 'text', { rows: 58, distinct: 9, samples: ['Ann Example', 'Bob Example | Contoso'] }),
    c('Archief', 'boolean', { rows: 58, distinct: 2 }),
    c('Risico klasse', 'text', { rows: 58, distinct: 3 }),
  );
  const result = heuristicProposal({ fileName: 'Klanten.xlsx', columns });

  it('turns the role column into a person entity named by that column, related by its role', () => {
    expectValid(result, columns);
    expect(entity(result, 'Eigenaar')).toEqual({ type: 'Eigenaar', keyColumn: 'Eigenaar', nameColumn: 'Eigenaar', attributes: [] });
    expect(result.recipe.relations).toEqual([{ predicate: 'eigenaar', from: 'Klant', to: 'Eigenaar' }]);
    expect(entity(result, 'Klant').attributes.map(a => a.column)).toEqual(['Archief', 'Risico klasse']);
  });

  it('matches that person to accounts by exact name first, then graded name', () => {
    expect(signalsOf(rule(result, 'Eigenaar'))).toEqual(['displayName>displayName:exact:80', 'displayName>displayName:name:60']);
    expect(result.notes).toContain('Eigenaar names a role, so Eigenaar is a person named by that column, matched to accounts by name.');
  });

  it('pairs a person column with the nearest employee-number column and matches on that number first', () => {
    nextIndex = 0;
    const cols = profile(
      c('Titel', 'text', { rows: 30 }),
      c('Personeelsnummer', 'number', { rows: 30, distinct: 12 }),
      c('Volledige naam', 'text', { rows: 30, distinct: 12 }),
      c('Afdeling', 'text', { rows: 30, distinct: 4 }),
    );
    const r = heuristicProposal({ fileName: 'Systemen.xlsx', columns: cols });
    expectValid(r, cols);
    expect(entity(r, 'VolledigeNaam')).toEqual({
      type: 'VolledigeNaam', keyColumn: 'Volledige naam', nameColumn: 'Volledige naam', attributes: [{ column: 'Personeelsnummer', name: 'employeeId' }],
    });
    expect(signalsOf(rule(r, 'VolledigeNaam'))).toEqual(['employeeId>employeeId:exact:95', 'displayName>displayName:exact:80', 'displayName>displayName:name:60']);
    expect(entity(r, 'System').attributes.map(a => a.column)).toEqual(['Afdeling']);
    expect(r.notes).toContain('Volledige naam holds a person\'s name, so VolledigeNaam is a person named by that column, matched to accounts by employee number (Personeelsnummer) and name.');
  });

  it('turns a SharePoint multi-lookup column into one person entity per name, related by the header', () => {
    nextIndex = 0;
    const cols = profile(
      c('Title', 'text', { rows: 30 }),
      c('Team', 'text', { rows: 30, distinct: 20, samples: ['Ann Example;#27', 'Ann Example;#27;#Bob Example;#16'] }),
      c('Leden', 'text', { rows: 30, distinct: 20, samples: ['Ann Example; Bob Example'] }),
      c('Groep', 'text', { rows: 30, distinct: 20, samples: ['A; B'] }),
    );
    const r = heuristicProposal({ fileName: 'Klanten.xlsx', columns: cols });
    expectValid(r, cols);
    expect(r.recipe.entities.map(e => e.type)).toEqual(['Klant', 'TeamMember', 'LedenMember']);
    expect(r.recipe.relations).toEqual([
      { predicate: 'team', from: 'Klant', to: 'TeamMember' }, { predicate: 'leden', from: 'Klant', to: 'LedenMember' },
    ]);
    expect(entity(r, 'Klant').attributes.map(a => a.column)).toEqual(['Groep']);
    expect(r.notes).toContain('Team lists several people per row, so TeamMember is a person named by that column, matched to accounts by name; each name in the cell becomes its own TeamMember.');
  });

  it('does not take a role column an e-mail column already uses as its name, and ignores non-text role columns', () => {
    nextIndex = 0;
    const cols = profile(
      c('Title', 'text', { rows: 20 }),
      c('Owner', 'text', { rows: 20, distinct: 5 }),
      c('Owner email', 'email', { rows: 20, distinct: 5 }),
      c('Manager', 'number', { rows: 20, distinct: 5 }),
    );
    const r = heuristicProposal({ fileName: 'Assets.xlsx', columns: cols });
    expect(r.recipe.entities.map(e => e.type)).toEqual(['Asset', 'Owner']);
    expect(entity(r, 'Owner').attributes).toEqual([{ column: 'Owner email', name: 'email' }]);
    expect(entity(r, 'Asset').attributes.map(a => a.column)).toEqual(['Manager']);
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
