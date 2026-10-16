import { describe, it, expect } from 'vitest';
import {
  emailPrefix, heuristicProposal, looksLikeGroupNames, personNameColumn, usableColumns, MAX_NOTES,
  isRoleColumn, isFullNameColumn, isEmployeeIdColumn, isMultiPersonColumn,
} from './heuristic.js';
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
const entity = (result) => result.recipe.entities[0];
const rule = (result, targetType, via) => result.linkRules.find(r => r.targetType === targetType && r.via === via);
const ruleNames = (result) => result.linkRules.map(r => r.name);
const signalsOf = (r) => r.signals.map(s => `${s.attribute}>${s.targetField}:${s.type}:${s.weight}`);

describe('heuristicProposal — a project list with an owner (name + e-mail)', () => {
  const columns = profile(
    c('ProjectCode', 'text', { samples: ['P-001', 'P-002'] }),
    c('ProjectName', 'text', { distinct: 98, samples: ['Website relaunch', 'Data platform'] }),
    c('Budget', 'number', { distinct: 40 }),
    c('OwnerName', 'text', { distinct: 30 }),
    c('OwnerEmail', 'email', { distinct: 30, samples: ['a.jansen@contoso.com'] }),
  );
  const result = heuristicProposal({ fileName: 'Projects.xlsx', columns });

  it('proposes ONE entity, Project, keyed on its code and named by its name column, with every other column as an attribute', () => {
    expect(result.recipe.entities).toHaveLength(1);
    expect(result.recipe.relations).toEqual([]);
    expect(entity(result)).toEqual({
      type: 'Project', keyColumn: 'ProjectCode', nameColumn: 'ProjectName',
      attributes: [{ column: 'Budget', name: 'budget' }, { column: 'OwnerName', name: 'ownerName' }, { column: 'OwnerEmail', name: 'ownerEmail' }],
    });
    expectValid(result, columns);
  });

  it('links the project to resources by name, and through the e-mail attribute to accounts (name as a second signal)', () => {
    expect(ruleNames(result)).toEqual(['Project → Resource via displayName', 'Project → Principal via ownerEmail']);
    expect(signalsOf(rule(result, 'Resource', 'displayName'))).toEqual(['displayName>displayName:exact:80', 'displayName>displayName:token:50']);
    expect(signalsOf(rule(result, 'Principal', 'ownerEmail'))).toEqual(['ownerEmail>email:exact:90', 'ownerEmail>email:prefix:80', 'ownerName>displayName:name:60']);
    expect(rule(result, 'Principal', 'ownerEmail').threshold).toBe(50);
  });

  it('does not also make a rule through the name column the e-mail rule uses', () => {
    expect(rule(result, 'Principal', 'ownerName')).toBeUndefined();
  });

  it('explains each decision in a sentence', () => {
    expect(result.notes).toEqual([
      'ProjectCode is unique on every row, so it is the key of Project, and ProjectName is its name.',
      'Project is also matched to resources by name (ProjectName); the quality step shows whether that finds anything.',
      'OwnerEmail looks like an e-mail address, so Project is linked through it to accounts, with OwnerName as the name.',
    ]);
  });
});

describe('heuristicProposal — a team list: an owner by name, a multi-person cell, no addresses', () => {
  const columns = profile(
    c('Title', 'text', { rows: 58, samples: ['Contoso Bank', 'Northwind Finance'] }),
    c('Eigenaar', 'text', { rows: 58, distinct: 9, samples: ['Ann Example', 'Bob Example | Contoso'] }),
    c('Archief', 'boolean', { rows: 58, distinct: 2 }),
    c('Team', 'text', { rows: 58, distinct: 20, samples: ['Ann Example;#27', 'Ann Example;#27;#Bob Example;#16'] }),
    c('Risico klasse', 'text', { rows: 58, distinct: 3 }),
  );
  const result = heuristicProposal({ fileName: 'Fortigi-Teams.xlsx', columns });

  it('keeps Eigenaar and Team as attributes of the one entity', () => {
    expect(result.recipe.entities).toHaveLength(1);
    expect(entity(result).attributes.map(a => a.name)).toEqual(['eigenaar', 'archief', 'team', 'risicoKlasse']);
    expectValid(result, columns);
  });

  it('links through eigenaar and through team to accounts by name, and the row to resources', () => {
    expect(ruleNames(result)).toEqual(['FortigiTeam → Resource via displayName', 'FortigiTeam → Principal via eigenaar', 'FortigiTeam → Principal via team']);
    expect(signalsOf(rule(result, 'Principal', 'eigenaar'))).toEqual(['eigenaar>displayName:exact:80', 'eigenaar>displayName:name:60']);
    expect(signalsOf(rule(result, 'Principal', 'team'))).toEqual(['team>displayName:exact:80', 'team>displayName:name:60']);
    expect(result.notes).toContain('Eigenaar names a role, so FortigiTeam is linked through it to accounts by name.');
    expect(result.notes).toContain('Team lists several people per row, so FortigiTeam is linked through it to accounts by name; each name in the cell is linked.');
  });
});

describe('heuristicProposal — employee numbers, full names, group-like names', () => {
  it('pairs a person attribute with the nearest employee-number column as its strongest signal', () => {
    const cols = profile(
      c('Titel', 'text', { rows: 30 }),
      c('Personeelsnummer', 'number', { rows: 30, distinct: 12 }),
      c('Volledige naam', 'text', { rows: 30, distinct: 12 }),
      c('Afdeling', 'text', { rows: 30, distinct: 4 }),
    );
    const r = heuristicProposal({ fileName: 'Systemen.xlsx', columns: cols });
    expectValid(r, cols);
    expect(entity(r).attributes.map(a => a.name)).toEqual(['personeelsnummer', 'volledigeNaam', 'afdeling']);
    expect(signalsOf(rule(r, 'Principal', 'volledigeNaam'))).toEqual(['personeelsnummer>employeeId:exact:95', 'volledigeNaam>displayName:exact:80', 'volledigeNaam>displayName:name:60']);
    expect(r.notes).toContain('Volledige naam holds a person\'s name, so System is linked through it to accounts by employee number (Personeelsnummer) and name.');
  });

  it('a role column that an e-mail column uses as its name gets no rule of its own; a numeric role column is no person', () => {
    const cols = profile(
      c('Title', 'text', { rows: 20 }),
      c('Owner', 'text', { rows: 20, distinct: 5 }),
      c('Owner email', 'email', { rows: 20, distinct: 5 }),
      c('Manager', 'number', { rows: 20, distinct: 5 }),
    );
    const r = heuristicProposal({ fileName: 'Assets.xlsx', columns: cols });
    expectValid(r, cols);
    expect(ruleNames(r)).toEqual(['Asset → Resource via displayName', 'Asset → Principal via ownerEmail']);
    expect(signalsOf(rule(r, 'Principal', 'ownerEmail'))).toContain('owner>displayName:name:60');
  });

  it('says so when the names look like group names', () => {
    const cols = profile(c('Group', 'text', { samples: ['SG_SAP_PROD', 'GG-Finance', 'DL_All'] }), c('Owner', 'text', { distinct: 10 }));
    const r = heuristicProposal({ fileName: 'Groups.csv', columns: cols });
    expect(r.notes).toContain('The values of Group look like group names, so Group is matched to groups.');
    expect(rule(r, 'Resource', 'displayName')).toBeDefined();
  });
});

describe('heuristicProposal — degenerate profiles', () => {
  it('one text column: one Item entity named and keyed by it, the resource rule only', () => {
    const columns = profile(c('Whatever', 'text', { distinct: 3 }));
    const result = heuristicProposal({ columns });
    expect(result.recipe).toEqual({ version: 1, template: 'collection', entities: [{ type: 'Item', nameColumn: 'Whatever', keyColumn: 'Whatever', attributes: [] }], relations: [] });
    expect(ruleNames(result)).toEqual(['Item → Resource via displayName']);
    expect(result.notes[0]).toBe('No column is unique enough to be a key, so Item is identified by Whatever.');
    expectValid(result, columns);
  });

  it('no unique column: no keyColumn chosen, the name header names it', () => {
    const columns = profile(c('Category', 'text', { distinct: 4 }), c('Description', 'text', { distinct: 70 }), c('Flag', 'boolean', { distinct: 2 }));
    const result = heuristicProposal({ fileName: 'things.csv', columns });
    // no key chosen: after normalisation the key column is the name column
    expect(entity(result)).toEqual({ type: 'Thing', nameColumn: 'Description', keyColumn: 'Description', attributes: [{ column: 'Category', name: 'category' }, { column: 'Flag', name: 'flag' }] });
    expect(result.notes[0]).toBe('No column is unique enough to be a key, so Thing is identified by Description.');
    expectValid(result, columns);
  });

  it('a unique column that is too empty is not a key; a numeric ID is when no text column qualifies, and names it too without a name header', () => {
    const columns = profile(c('Sparse', 'text', { nonEmpty: 50, distinct: 50 }), c('Nr', 'number'), c('Label', 'text', { distinct: 20 }));
    const result = heuristicProposal({ columns });
    expect(entity(result)).toMatchObject({ keyColumn: 'Nr', nameColumn: 'Nr' });
    expect(entity(result).attributes.map(a => a.column)).toEqual(['Sparse', 'Label']);
  });

  it('just under the uniqueness and fill limits is not a key, exactly on them is', () => {
    const under = heuristicProposal({ columns: profile(c('Code', 'text', { nonEmpty: 89, distinct: 89 }), c('Name', 'text', { distinct: 10 })) });
    expect(entity(under)).toMatchObject({ keyColumn: 'Name', nameColumn: 'Name' });
    expect(under.notes[0]).toMatch(/^No column is unique enough/);
    const on = heuristicProposal({ columns: profile(c('Code', 'text', { nonEmpty: 90, distinct: 72 }), c('Name', 'text', { distinct: 10 })) });
    expect(entity(on)).toMatchObject({ keyColumn: 'Code', nameColumn: 'Name' });
  });

  it('only an e-mail column: the entity is named by the address and linked through its name to accounts by e-mail', () => {
    const columns = profile(c('Email', 'email', { distinct: 100, samples: ['x@contoso.com'] }));
    const result = heuristicProposal({ fileName: 'contacts.csv', columns });
    expect(entity(result)).toEqual({ type: 'Contact', nameColumn: 'Email', keyColumn: 'Email', attributes: [] });
    // the e-mail column IS the name column, so it is not an attribute rule; the resource rule remains
    expect(ruleNames(result)).toEqual(['Contact → Resource via displayName']);
    expectValid(result, columns);
  });

  it('headers that camelCase to nothing or to a reserved name still get unique attribute names', () => {
    const columns = profile(c('Title', 'text'), c('???', 'text', { distinct: 5 }), c('Display Name', 'text', { distinct: 5 }), c('display name', 'text', { distinct: 5 }));
    const result = heuristicProposal({ columns });
    // Title is the key; "Display Name" is the name column (a name header); the rest are attributes
    expect(entity(result)).toMatchObject({ keyColumn: 'Title', nameColumn: 'Display Name' });
    expect(entity(result).attributes.map(a => a.name)).toEqual(['column2', 'displayName2']);
    expectValid(result, columns);
  });

  it('ignores columns without a name, and refuses a profile with none', () => {
    const result = heuristicProposal({ columns: [{ name: '', shape: 'text' }, { name: 'Id', shape: 'text', nonEmpty: 10, distinct: 10, uniqueness: 1 }] });
    expect(entity(result).nameColumn).toBe('Id');
    expect(() => heuristicProposal({ columns: [] })).toThrow(/no named columns/);
    expect(() => heuristicProposal({})).toThrow(/no named columns/);
  });

  it('survives missing counts and indexes in the profile', () => {
    const result = heuristicProposal({ columns: [{ name: 'A', shape: 'text' }, { name: 'Owner', shape: 'text' }] });
    expect(entity(result).nameColumn).toBe('A');
    expect(ruleNames(result)).toEqual(['Item → Resource via displayName', 'Item → Principal via owner']);
  });
});

describe('heuristicProposal — realistic lists', () => {
  it('a 12-row project list with one duplicate code still keys Project on that code', () => {
    const columns = profile(
      c('ProjectCode', 'text', { rows: 12, distinct: 11, samples: ['P-001'] }),
      c('ProjectName', 'text', { rows: 12, distinct: 12 }),
      c('OwnerEmail', 'email', { rows: 12, distinct: 5 }),
    );
    const result = heuristicProposal({ fileName: 'Projects.xlsx', columns });
    expect(entity(result)).toMatchObject({ type: 'Project', keyColumn: 'ProjectCode', nameColumn: 'ProjectName' });
    expect(result.notes[0]).toBe('ProjectCode is nearly unique (a few values repeat), so it is the key of Project, and ProjectName is its name.');
  });

  it('without a key-like header the most unique column wins, the leftmost on a tie', () => {
    const columns = profile(c('Alpha', 'text', { distinct: 95 }), c('Beta', 'text', { distinct: 95 }), c('Gamma', 'text', { distinct: 90 }));
    expect(entity(heuristicProposal({ columns })).keyColumn).toBe('Alpha');
  });

  it('an e-mail attribute without a sibling name column is linked on the address alone', () => {
    const columns = profile(c('Project', 'text', { rows: 12 }), c('OwnerEmail', 'email', { rows: 12, distinct: 5, samples: ['a@contoso.com'] }));
    const result = heuristicProposal({ fileName: 'Projects.xlsx', columns });
    expect(signalsOf(rule(result, 'Principal', 'ownerEmail'))).toEqual(['ownerEmail>email:exact:90', 'ownerEmail>email:prefix:80']);
    expect(result.notes).toContain('OwnerEmail looks like an e-mail address, so Project is linked through it to accounts.');
  });

  it('never proposes more notes than MAX_NOTES', () => {
    const columns = profile(...Array.from({ length: 12 }, (_, i) => c(`Owner ${i} email`, 'email', { distinct: 5 })), c('Title', 'text'));
    expect(heuristicProposal({ columns }).notes.length).toBeLessThanOrEqual(MAX_NOTES);
  });
});

describe('helpers', () => {
  it('emailPrefix strips the e-mail words wherever they stand', () => {
    expect(emailPrefix('OwnerEmail')).toBe('Owner');
    expect(emailPrefix('E-mailadres eigenaar')).toBe('eigenaar');
    expect(emailPrefix('Email')).toBe('');
    expect(emailPrefix('UPN')).toBe('');
  });

  it('personNameColumn picks the nearest sibling with the same prefix', () => {
    const email = { name: 'OwnerEmail', index: 5 };
    const free = [{ name: 'Owner name', index: 1 }, { name: 'Budget', index: 2 }, { name: 'Owner', index: 4 }];
    expect(personNameColumn(email, 'Owner', free).name).toBe('Owner');
    expect(personNameColumn(email, '', free)).toBeNull();
    expect(personNameColumn(email, 'Sponsor', free)).toBeNull();
  });

  it('looksLikeGroupNames needs at least half of the non-empty samples to look like groups', () => {
    expect(looksLikeGroupNames(['SG_A', 'plain', 'x_y', ''])).toBe(true);
    expect(looksLikeGroupNames(['SG_A', 'plain', 'other'])).toBe(false);
    expect(looksLikeGroupNames([])).toBe(false);
    expect(looksLikeGroupNames(undefined)).toBe(false);
  });

  it('column classifiers: role, full name, employee number, multi-person', () => {
    expect(isRoleColumn({ name: 'Project owner', shape: 'text' })).toBe(true);
    expect(isRoleColumn({ name: 'Owner', shape: 'number' })).toBe(false);
    expect(isFullNameColumn({ name: 'Volledige naam', shape: 'text' })).toBe(true);
    expect(isFullNameColumn({ name: 'Naam project', shape: 'text' })).toBe(false);
    expect(isEmployeeIdColumn({ name: 'Personeelsnummer', shape: 'number' })).toBe(true);
    expect(isEmployeeIdColumn({ name: 'Employee ID', shape: 'text' })).toBe(true);
    expect(isEmployeeIdColumn({ name: 'Nummer', shape: 'number' })).toBe(false);
    expect(isMultiPersonColumn({ name: 'Anything', shape: 'text', samples: ['A;#1;#B;#2'] })).toBe(true);
    expect(isMultiPersonColumn({ name: 'Leden', shape: 'text', samples: ['A; B'] })).toBe(true);
    expect(isMultiPersonColumn({ name: 'Leden', shape: 'text', samples: ['A'] })).toBe(false);
    expect(isMultiPersonColumn({ name: 'Notes', shape: 'text', samples: ['a; b'] })).toBe(false);
  });

  it('usableColumns keeps named columns in order and fills a missing index', () => {
    expect(usableColumns([{ name: 'A' }, { name: ' ' }, { name: 'B', index: 7 }, null])).toEqual([{ name: 'A', index: 0 }, { name: 'B', index: 7 }]);
    expect(usableColumns(undefined)).toEqual([]);
  });
});

describe('heuristicProposal — with data probes', () => {
  const probe = (p) => ({ values: 10, people: 0, resources: 0, orgEntities: 0, orgEntityTypes: [], ...p });

  describe('a headerless person list', () => {
    const columns = profile(
      c('Column 1', 'text', { samples: ['Ann Example'] }),
      c('Column 2', 'text', { distinct: 5, samples: ['Finance'] }),
    );

    it('a name column of at least 50 % people links each row to its own account, not to resources', () => {
      const r = heuristicProposal({ fileName: 'Staff.csv', columns, probes: { 'Column 1': probe({ people: 0.5 }) } });
      expectValid(r, columns);
      expect(r.linkRules.map(x => [x.targetType, x.via])).toEqual([['Principal', 'displayName']]);
      expect(rule(r, 'Principal', 'displayName')).toMatchObject({ threshold: 50 });
      expect(signalsOf(rule(r, 'Principal', 'displayName'))).toEqual(['displayName>displayName:exact:80', 'displayName>displayName:name:60']);
      expect(r.notes).toContain('50 % of the values of Column 1 are accounts, so every Staff is a person, linked to their account by name.');
    });

    it('just under 50 % people: the resource rule as before', () => {
      const r = heuristicProposal({ fileName: 'Staff.csv', columns, probes: { 'Column 1': probe({ people: 0.49 }) } });
      expect(r.linkRules.map(x => [x.targetType, x.via])).toEqual([['Resource', 'displayName']]);
    });

    it('people that are also resources (a quarter or more) keep the resource rule first', () => {
      const r = heuristicProposal({ fileName: 'Staff.csv', columns, probes: { 'Column 1': probe({ people: 0.8, resources: 0.25 }) } });
      expect(r.linkRules.map(x => [x.targetType, x.via])).toEqual([['Resource', 'displayName'], ['Principal', 'displayName']]);
      const under = heuristicProposal({ fileName: 'Staff.csv', columns, probes: { 'Column 1': probe({ people: 0.8, resources: 0.24 }) } });
      expect(under.linkRules.map(x => x.targetType)).toEqual(['Principal']);
    });

    it('without probes nothing changes: no column is taken for people by its values', () => {
      const r = heuristicProposal({ fileName: 'Staff.csv', columns });
      expect(r).toEqual(heuristicProposal({ fileName: 'Staff.csv', columns, probes: null, compositeKey: null }));
      expect(r.linkRules.map(x => [x.targetType, x.via])).toEqual([['Resource', 'displayName']]);
    });
  });

  describe('a timesheet (a fact list without a key)', () => {
    const columns = profile(
      c('Jaar', 'number', { distinct: 1, samples: ['2026'] }),
      c('Maand', 'text', { distinct: 12, samples: ['januari'] }),
      c('Medewerker', 'text', { distinct: 20, samples: ['Ann Example'] }),
      c('Klant', 'text', { distinct: 30, samples: ['Contoso'] }),
      c('Uren', 'number', { distinct: 50, samples: ['8,5'] }),
    );
    const probes = {
      Medewerker: probe({ people: 0.95 }),
      Klant: probe({ orgEntities: 0.9, orgEntityTypes: ['Customer', 'Supplier'] }),
    };
    const compositeKey = ['Jaar', 'Maand', 'Medewerker', 'Klant'];
    const r = heuristicProposal({ fileName: 'Uren.xlsx', columns, probes, compositeKey });

    it('keys every row on the composite key and names it after the other list it refers to', () => {
      expectValid(r, columns);
      expect(entity(r)).toMatchObject({ nameColumn: 'Klant', keyColumns: compositeKey });
      expect(r.notes[0]).toBe('No single column is unique, but Jaar + Maand + Medewerker + Klant together are, so every row is one Uren, named after Klant.');
    });

    it('links the row by its name to the other list (fuzzy 100, threshold 60) and its person column to accounts', () => {
      expect(r.linkRules.map(x => [x.targetType, x.via])).toEqual([['OrgEntity', 'displayName'], ['Principal', 'medewerker']]);
      expect(rule(r, 'OrgEntity', 'displayName')).toMatchObject({ threshold: 60 });
      expect(signalsOf(rule(r, 'OrgEntity', 'displayName'))).toEqual(['displayName>displayName:fuzzy:100']);
      // names the most frequent list its values matched (the probe lists them most frequent first)
      expect(rule(r, 'OrgEntity', 'displayName').targetEntityType).toBe('Customer');
      expect(r.notes).toContain('90 % of the values of Klant match a Customer from another list, so Uren is linked through it to that list (fuzzy on the name).');
    });

    it('without an org-entity column the row is named after its person column', () => {
      const p = heuristicProposal({ fileName: 'Uren.xlsx', columns, probes: { Medewerker: probes.Medewerker }, compositeKey });
      expect(entity(p).nameColumn).toBe('Medewerker');
      expect(rule(p, 'Principal', 'displayName')).toBeDefined();
    });

    it('a composite key is ignored when a single column is a key, or when it has fewer than two columns', () => {
      const withKey = profile(c('Code', 'text', { samples: ['A'] }), c('Naam', 'text'));
      expect(entity(heuristicProposal({ fileName: 'x.csv', columns: withKey, compositeKey: ['Code', 'Naam'] }))).not.toHaveProperty('keyColumns');
      expect(entity(heuristicProposal({ fileName: 'Uren.xlsx', columns, probes, compositeKey: ['Jaar'] }))).not.toHaveProperty('keyColumns');
    });
  });

  describe('an attribute naming another list', () => {
    const columns = profile(
      c('ProjectCode', 'text', { samples: ['P-1'] }),
      c('ProjectName', 'text'),
      c('Klant', 'text', { distinct: 20, samples: ['Contoso'] }),
      c('Opdrachtgever', 'text', { distinct: 20, samples: ['Contoso'] }),
    );

    it('a column of at least 50 % other-list entities links through it (OrgEntity, fuzzy 100, threshold 60)', () => {
      const r = heuristicProposal({
        fileName: 'Projects.xlsx', columns,
        probes: { Klant: probe({ orgEntities: 0.5 }), Opdrachtgever: probe({ orgEntities: 0.49 }) },
      });
      expectValid(r, columns);
      expect(rule(r, 'OrgEntity', 'klant')).toMatchObject({ threshold: 60 });
      expect(signalsOf(rule(r, 'OrgEntity', 'klant'))).toEqual(['klant>displayName:fuzzy:100']);
      expect(rule(r, 'OrgEntity', 'opdrachtgever')).toBeUndefined();
      // the probe named no list, so the rule names none
      expect(rule(r, 'OrgEntity', 'klant')).not.toHaveProperty('targetEntityType');
      expect(r.notes).toContain('50 % of the values of Klant match an entity from another list, so Project is linked through it to that list (fuzzy on the name).');
    });

    it('a column of people is a person rule, never also an org-entity rule', () => {
      const r = heuristicProposal({ fileName: 'Projects.xlsx', columns, probes: { Klant: probe({ people: 0.7, orgEntities: 0.9 }) } });
      expect(r.linkRules.filter(x => x.via === 'klant').map(x => x.targetType)).toEqual(['Principal']);
    });
  });
});
