import { describe, it, expect } from 'vitest';
import { templateProposal } from './templateRecipes.js';
import { validateRecipe, validateLinkRules } from '../contracts.js';

const c = (name, shape, samples, index, over = {}) => ({ name, shape, samples, index, nonEmpty: 10, distinct: 4, uniqueness: 0.4, ...over });
const probe = (people = 0, orgEntities = 0, resources = 0, orgEntityTypes = []) => ({ people, orgEntities, resources, orgEntityTypes });
const names = (cols) => cols.map(x => x.name);

describe('activity proposal', () => {
  const cols = [
    c('Datum', 'date', ['2026-03-01'], 0), c('Medewerker', 'text', ['Ann'], 1), c('Klant', 'text', ['Contoso'], 2),
    c('Uren', 'number', ['7,5'], 3), c('Omschrijving', 'text', ['werk'], 4),
  ];

  it('with picks: the date, the unit from the header, the subject\'s list, the rest as attributes', () => {
    const picks = { time: { dateColumn: 'Datum', used: [cols[0]] }, measure: cols[3], actor: cols[1], subject: cols[2] };
    const out = templateProposal('activity', { fileName: 'Timesheet.xlsx', columns: cols, probes: { Klant: probe(0, 0.9, 0, ['Customer']) }, picks });
    expect(out.recipe.activity).toEqual({
      type: 'Timesheet',
      actor: { column: 'Medewerker', targetTypes: ['Principal', 'Identity'] },
      subject: { column: 'Klant', targetType: 'OrgEntity', targetEntityType: 'Customer' },
      when: { dateColumn: 'Datum' },
      measure: { column: 'Uren', unit: 'h' },
      attributes: [{ column: 'Omschrijving', name: 'omschrijving' }],
    });
    expect(out.linkRules).toEqual([]);
    expect(out.notes).toEqual(['Each row is one Timesheet of Medewerker on Klant; every distinct value is matched once and can be reviewed under Activity references.']);
  });

  it('a subject of resources targets Resource; a subject that looks like people still targets Resource (never an account)', () => {
    const picks = { time: { dateColumn: 'Datum', used: [cols[0]] }, measure: cols[3], actor: cols[1], subject: cols[2] };
    expect(templateProposal('activity', { columns: cols, probes: { Klant: probe(0, 0, 0.7) }, picks }).recipe.activity.subject).toEqual({ column: 'Klant', targetType: 'Resource' });
    expect(templateProposal('activity', { columns: cols, probes: { Klant: probe(0.9, 0, 0.1) }, picks }).recipe.activity.subject).toEqual({ column: 'Klant', targetType: 'Resource' });
    // no probe at all: Resource, and an untitled file is an "Activity"
    const bare = templateProposal('activity', { columns: cols, probes: null, picks });
    expect(bare.recipe.activity.subject.targetType).toBe('Resource');
    expect(bare.recipe.activity.type).toBe('Activity');
  });

  it('forced without picks: the free columns stand in, with a note to check them', () => {
    const plain = [c('Jaar', 'number', ['2026'], 0), c('Maand', 'text', ['maart'], 1), c('Wie', 'text', ['Ann'], 2), c('Wat', 'text', ['x'], 3), c('Bedrag', 'number', ['10,50'], 4)];
    const out = templateProposal('activity', { columns: plain, probes: null });
    expect(out.recipe.activity).toMatchObject({
      when: { yearColumn: 'Jaar', monthColumn: 'Maand' }, actor: { column: 'Wie' }, subject: { column: 'Wat' }, measure: { column: 'Bedrag', unit: 'EUR' },
    });
    expect(out.notes[0]).toBe('Check the actor, subject and date columns: the data did not point them out clearly.');
    expect(validateRecipe(out.recipe, names(plain)).ok).toBe(true);
  });

  it('forced on a two-column list: still the activity shape (columns reused as guesses), no measure, and the check note', () => {
    const two = [c('A', 'text', ['x'], 0), c('B', 'text', ['y'], 1)];
    const out = templateProposal('activity', { columns: two, probes: null });
    expect(out.recipe.template).toBe('activity');
    expect('measure' in out.recipe.activity).toBe(false);
    expect(out.recipe.activity.when).toEqual({ yearColumn: 'A', monthColumn: 'B' });
    expect([out.recipe.activity.actor.column, out.recipe.activity.subject.column]).toEqual(['A', 'A']);
    expect(out.notes[0]).toMatch(/^Check the actor, subject and date columns/);
  });
});

describe('enrichment proposal', () => {
  const cols = [
    c('Naam', 'text', ['Ann Example'], 0, { uniqueness: 1 }), c('Mail', 'email', ['ann@contoso.com'], 1, { uniqueness: 1 }),
    c('Skills', 'text', ['IAM, Azure', 'Azure', 'IAM; Sec'], 2), c('Rol', 'text', ['Lead, Senior', 'Lead', 'Junior'], 3),
  ];

  it('people: Identity when identities exist, keyed on the unique address, the address as an extra signal', () => {
    const out = templateProposal('enrichment', { fileName: 'Staff.xlsx', columns: cols, probes: { Naam: probe(1) }, picks: { key: cols[0], targetKind: 'person' }, hasIdentities: true });
    expect(out.recipe).toEqual({
      version: 1, template: 'enrichment', enrich: { targetType: 'Identity' },
      entities: [{ type: 'Staff', nameColumn: 'Naam', keyColumn: 'Mail', attributes: [
        { column: 'Mail', name: 'mail' }, { column: 'Skills', name: 'skills', multi: true }, { column: 'Rol', name: 'rol' },
      ] }],
      relations: [],
    });
    expect(out.linkRules[0].signals.at(-1)).toEqual({ name: 'mail email exact', attribute: 'mail', targetField: 'email', type: 'exact', weight: 95, order: 4 });
    expect(validateLinkRules(out.linkRules, out.recipe).ok).toBe(true);
    expect(out.notes).toEqual([
      'Every row adds information to the Identity named in Naam (or with the address in Mail).',
      'skills hold several values per cell; each value is kept, so you can filter on any of them.',
    ]);
  });

  it('people without identities enrich accounts; resources enrich resources without an address signal', () => {
    expect(templateProposal('enrichment', { columns: cols, probes: null, picks: { key: cols[0], targetKind: 'person' } }).recipe.enrich.targetType).toBe('Principal');
    const out = templateProposal('enrichment', { columns: cols, probes: null, picks: { key: cols[0], targetKind: 'resource' } });
    expect(out.recipe.enrich.targetType).toBe('Resource');
    expect(out.linkRules[0].signals.some(s => s.targetField === 'email')).toBe(false);
    expect(out.recipe.entities[0].type).toBe('Enrichment');
  });

  it('a multi-valued column needs separators in at least half of its samples', () => {
    const half = c('Tags', 'text', ['a, b', 'c'], 2);
    const less = c('Tags', 'text', ['a, b', 'c', 'd'], 2);
    const attr = (col) => templateProposal('enrichment', { columns: [cols[0], col], probes: null, picks: { key: cols[0] } }).recipe.entities[0].attributes[0];
    expect(attr(half).multi).toBe(true);
    expect(attr(less).multi).toBeUndefined();
  });

  it('forced without picks: the first people column is the key, no address column means the key is the key', () => {
    const plain = [c('Code', 'text', ['1'], 0), c('Eigenaar', 'text', ['Ann'], 1), c('Note', 'text', ['x'], 2)];
    const out = templateProposal('enrichment', { columns: plain, probes: null });
    expect(out.recipe.entities[0]).toMatchObject({ nameColumn: 'Eigenaar', keyColumn: 'Eigenaar' });
  });
});

describe('relation proposal', () => {
  it('targets per end from the probes, a placeholder predicate, the rest as attributes', () => {
    const cols = [c('Wie', 'text', ['Ann'], 0), c('App', 'text', ['Atlas'], 1), c('Waarom', 'text', ['x'], 2)];
    const out = templateProposal('relation', { fileName: 'pairs.csv', columns: cols, probes: { Wie: probe(0.9), App: probe(0, 0.8, 0, ['Application']) }, picks: { left: cols[0], right: cols[1] } });
    expect(out.recipe.relation).toEqual({
      type: 'Pair', predicate: 'relatedTo',
      left: { column: 'Wie', targetType: 'Principal' },
      right: { column: 'App', targetType: 'OrgEntity', targetEntityType: 'Application' },
      attributes: [{ column: 'Waarom', name: 'waarom' }],
    });
    expect(out.linkRules.map(r => [r.via, r.targetType])).toEqual([['left', 'Principal'], ['right', 'OrgEntity']]);
  });

  it('an extra column named left or right gets another name; without picks the first two columns pair up', () => {
    const cols = [c('A', 'text', ['x'], 0), c('B', 'text', ['y'], 1), c('Left', 'text', ['z'], 2)];
    const out = templateProposal('relation', { columns: cols, probes: null });
    expect(out.recipe.relation).toMatchObject({ type: 'Relation', left: { column: 'A', targetType: 'Resource' }, right: { column: 'B' } });
    expect(out.recipe.relation.attributes).toEqual([{ column: 'Left', name: 'left2' }]);
  });

  it('a list of one column cannot pair: the shape stays, the notes say why it does not validate', () => {
    const out = templateProposal('relation', { columns: [c('A', 'text', ['x'], 0)], probes: null });
    expect(out.recipe.template).toBe('relation');
    expect(out.linkRules).toEqual([]);
    expect(out.notes.at(-1)).toBe('The relation\'s left and right ends must be different columns.');
  });
});
