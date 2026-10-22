import { describe, it, expect } from 'vitest';
import { guessMapping, listNameFrom, memberKindOf, templateOf, says, words, squash } from './guess.js';
import { profileColumns } from './profile.js';

const guessFor = (fileName, columns, rows) => guessMapping({ fileName, profile: profileColumns(columns, rows), rowCount: rows.length });

describe('words / squash / says', () => {
  it('splits at separators and case changes', () => {
    expect(words('OwnerEmail')).toEqual(['Owner', 'Email']);
    expect(words('e-mail_eigenaar')).toEqual(['e', 'mail', 'eigenaar']);
    expect(squash('Owner_Name')).toBe('ownername');
  });

  it('matches a word, or a Dutch compound ending in a word of at least four letters', () => {
    const v = new Set(['nummer', 'id']);
    expect(says('Klant ID', v)).toBe(true);
    expect(says('Klantnummer', v)).toBe(true);
    // "id" is two letters: as a suffix it would also match "Paid".
    expect(says('Paid', v)).toBe(false);
  });
});

describe('listNameFrom', () => {
  it.each([
    ['klanten.xlsx', 'Klanten'],
    ['Klanten export 2026-10.csv', 'Klanten'],
    ['C:\\temp\\applicatie overzicht.csv', 'Applicatie'],
    ['export 2026.csv', 'List'],
  ])('%s → %s', (file, name) => {
    expect(listNameFrom(file)).toBe(name);
  });
});

describe('guessMapping — the hackathon customers list (Dutch)', () => {
  const columns = ['Klantnummer', 'Naam', 'Sector', 'Eigenaar', 'Gebruikers', 'Applicaties'];
  const rows = [
    { Klantnummer: 'K1', Naam: 'Acme', Sector: 'Zorg', Eigenaar: 'o@x.nl', Gebruikers: 'a@x.nl; b@x.nl', Applicaties: 'SG_App1;SG_App2' },
    { Klantnummer: 'K2', Naam: 'Beta', Sector: 'Bouw', Eigenaar: 'p@x.nl', Gebruikers: 'c@x.nl', Applicaties: 'SG_App3' },
  ];
  const g = guessFor('klanten.xlsx', columns, rows);

  it('is an organisation-unit list named after the file', () => {
    expect(g.template).toBe('OrganizationalUnit');
    expect(g.listName).toBe('Klanten');
  });

  it('takes the unique number column as the key and Naam as the name', () => {
    expect(g.keyColumn).toBe('Klantnummer');
    expect(g.nameColumn).toBe('Naam');
  });

  it('finds the owner and two kinds of member, accounts first for an organisation unit', () => {
    expect(g.ownerColumn).toBe('Eigenaar');
    expect(g.memberColumns).toEqual([
      { column: 'Gebruikers', kind: 'Principal', shape: 'list' },
      { column: 'Applicaties', kind: 'Resource', shape: 'list' },
    ]);
  });

  it('makes every other column an attribute', () => {
    expect(g.attributeColumns).toEqual(['Sector']);
    expect(g.responsibleColumn).toBeNull();
    expect(g.parentColumn).toBeNull();
  });
});

describe('guessMapping — English application register', () => {
  const columns = ['Application', 'App ID', 'Owner', 'Responsible', 'Groups', 'Parent'];
  const rows = [
    { Application: 'Payroll', 'App ID': 'A1', Owner: 'o@x.nl', Responsible: 'r@x.nl', Groups: 'G1', Parent: '' },
    { Application: 'Payroll EU', 'App ID': 'A2', Owner: 'o@x.nl', Responsible: 'r@x.nl', Groups: 'G2', Parent: 'A1' },
  ];
  const g = guessFor('applications.csv', columns, rows);

  it('reads the header words: template, key, owner, responsible, parent and resource members', () => {
    expect(g).toMatchObject({
      template: 'LogicalApplication', nameColumn: 'Application', keyColumn: 'App ID',
      ownerColumn: 'Owner', responsibleColumn: 'Responsible', parentColumn: 'Parent',
      memberColumns: [{ column: 'Groups', kind: 'Resource', shape: 'list' }],
      attributeColumns: [],
    });
  });
});

describe('guessMapping — key and shape decisions', () => {
  it('a key-named column that repeats is not the key: the name is', () => {
    const g = guessFor('teams.csv', ['Name', 'Code'], [{ Name: 'A', Code: '1' }, { Name: 'B', Code: '1' }]);
    expect(g.keyColumn).toBe('Name');
  });

  it('a key-named column with one empty cell is not the key', () => {
    const g = guessFor('teams.csv', ['Name', 'Code'], [{ Name: 'A', Code: '1' }, { Name: 'B', Code: '' }]);
    expect(g.keyColumn).toBe('Name');
  });

  it('one member per row with the name repeating is long format', () => {
    const rows = [{ Naam: 'Acme', Leden: 'a@x.nl' }, { Naam: 'Acme', Leden: 'b@x.nl' }, { Naam: 'Beta', Leden: 'c@x.nl' }];
    expect(guessFor('k.csv', ['Naam', 'Leden'], rows).memberColumns).toEqual([{ column: 'Leden', kind: 'Principal', shape: 'long' }]);
  });

  it('one member per row with unique names is a list of one', () => {
    const rows = [{ Naam: 'Acme', Leden: 'a@x.nl' }, { Naam: 'Beta', Leden: 'c@x.nl' }];
    expect(guessFor('k.csv', ['Naam', 'Leden'], rows).memberColumns[0].shape).toBe('list');
  });

  it('keeps at most two kinds of member', () => {
    const cols = ['Naam', 'Medewerkers', 'Gebruikers', 'Groepen'];
    const g = guessFor('k.csv', cols, [{ Naam: 'A', Medewerkers: 'x', Gebruikers: 'y', Groepen: 'z' }]);
    expect(g.memberColumns.map(m => m.kind)).toEqual(['Identity', 'Principal']);
    expect(g.attributeColumns).toEqual(['Groepen']);
  });

  it('an application list puts its resource members first', () => {
    const g = guessFor('applicaties.csv', ['Naam', 'Gebruikers', 'Rollen'], [{ Naam: 'A', Gebruikers: 'u', Rollen: 'r' }]);
    expect(g.memberColumns.map(m => m.kind)).toEqual(['Resource', 'Principal']);
  });

  it('with no name-like header, the first fully unique text column is the name', () => {
    const rows = [{ Sector: 'Zorg', Klant: 'Acme' }, { Sector: 'Zorg', Klant: 'Beta' }];
    const g = guessFor('x.csv', ['Sector', 'Omschr'], rows.map(r => ({ Sector: r.Sector, Omschr: r.Klant })));
    expect(g.nameColumn).toBe('Omschr');
  });

  it('refuses a profile without columns', () => {
    expect(() => guessMapping({ fileName: 'x.csv', profile: [], rowCount: 0 })).toThrow(/no columns/);
  });
});

describe('memberKindOf / templateOf', () => {
  it('an unlabelled column of several addresses per cell holds accounts; a single address does not', () => {
    expect(memberKindOf({ name: 'Kolom 3', shape: 'email', multiValued: 0.5 })).toBe('Principal');
    expect(memberKindOf({ name: 'Kolom 3', shape: 'email', multiValued: 0 })).toBeNull();
  });

  it('an application word in the file name or the name header makes it an application list', () => {
    expect(templateOf('Applicaties.xlsx', { name: 'Naam' })).toBe('LogicalApplication');
    expect(templateOf('lijst.xlsx', { name: 'Application name' })).toBe('LogicalApplication');
    expect(templateOf('klanten.xlsx', { name: 'Naam' })).toBe('OrganizationalUnit');
  });
});
