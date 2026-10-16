import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseList } from '../import/parse.js';
import { profileColumns } from '../import/profileColumns.js';
import { buildTargets, probeColumns } from './probe.js';
import { propose } from './service.js';
import {
  chooseTemplate, evaluateActivity, evaluateRelation, evaluateEnrichment, isYearColumn, isMonthColumn, isMeasureColumn, namesPeople,
} from './template.js';
import { validateRecipe, validateLinkRules } from '../contracts.js';

// What is already known: accounts, a customer list ('Klant'), a few groups.
const targets = buildTargets(
  [
    { displayName: 'Ann Example', email: 'ann@contoso.com' }, { displayName: 'Bob Sample', email: 'bob@contoso.com' },
    { displayName: 'Cas Sample', email: 'cas@contoso.com' }, { displayName: 'Dee Example', email: 'dee@contoso.com' },
  ],
  [{ displayName: 'SG_Pay_Approve' }, { displayName: 'SG_Pay_Create' }, { displayName: 'SG_Vendor_Edit' }],
  [
    { displayName: 'Contoso', entityType: 'Klant' }, { displayName: 'Northwind Traders', entityType: 'Klant' },
    { displayName: 'Havenbedrijf Rotterdam', entityType: 'Klant' }, { displayName: 'Fabrikam', entityType: 'Klant' },
  ],
  true,
);

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function discover(buffer, fileName, forced) {
  const table = await parseList(buffer, { fileName });
  const columns = profileColumns(table.columns, table.rows);
  const probes = probeColumns(columns, table.rows, targets);
  const input = { fileName, columns, rowCount: table.rows.length, probes, hasIdentities: targets.hasIdentities, template: forced };
  return { chosen: chooseTemplate({ columns, probes, rowCount: table.rows.length, forced }), proposal: await propose(input), columns };
}

// A timesheet export: no header, ';', year;Dutch month;person;customer;hours with a decimal comma.
const TIMESHEET = [
  '2026;januari;Ann Example;Contoso;12,5',
  '2026;januari;Bob Sample;Northwind Traders;8',
  '2026;februari;Ann Example;Contoso;7,25',
  '2026;februari;Cas Sample;PortOfRotterdam;16',
  '2026;maart;Ann Example;Fabrikam;4,5',
  '2026;maart;Bob Sample;Contoso;3',
].join('\n');

// A staff list: one row per person, addresses, several expertises per cell.
const STAFF = [
  ['Volledige naam', 'E-mail', 'Privé mail', 'Expertises', 'Functie'],
  ['Ann Example', 'ann@contoso.com', 'ann@home.example', 'IAM, Azure, Security', 'Consultant'],
  ['Bob Sample', 'bob@contoso.com', 'bob@home.example', 'Azure', 'Architect'],
  ['Cas Sample', 'cas@contoso.com', 'cas@home.example', 'IAM; Governance', 'Consultant'],
  ['Dee Example', 'dee@contoso.com', 'dee@home.example', 'Security, Azure', 'Lead'],
];

// A SharePoint customer/teams export: title, owner, team as ';#' lookup, flags.
const CUSTOMERS = [
  ['Title', 'Eigenaar', 'Team', 'iso27001', 'archief', 'risicoKlasse'],
  ['Contoso', 'Ann Example', 'Bob Sample;#12;#Cas Sample;#14', 'true', 'false', 'Hoog'],
  ['Northwind Traders', 'Bob Sample', 'Ann Example;#11', 'false', 'false', 'Laag'],
  ['Fabrikam', 'Ann Example', 'Dee Example;#15;#Bob Sample;#12', 'true', 'true', 'Midden'],
];

// Pairs of incompatible authorisations.
const SOD = 'Recht A;Recht B;Reden\nSG_Pay_Approve;SG_Pay_Create;Four eyes\nSG_Pay_Approve;SG_Vendor_Edit;Fraud\nSG_Pay_Create;SG_Vendor_Edit;Fraud\n';

describe('discovery on the three real-world shapes', () => {
  it('a headerless timesheet is ACTIVITY: person → account, customer → the Klant list, year + month, hours', async () => {
    const { chosen, proposal } = await discover(Buffer.from(TIMESHEET), 'Uren 2026.csv');
    expect(chosen.summary.kind).toBe('activity');
    expect(chosen.summary.confidence).toBe(0.9);
    expect(chosen.summary.alternatives).toEqual(['collection', 'enrichment', 'relation']);
    expect(proposal.template).toEqual(chosen.summary);
    expect(proposal.origin).toBe('data');
    expect(proposal.linkRules).toEqual([]);
    expect(proposal.recipe).toEqual({
      version: 1, template: 'activity',
      activity: {
        type: 'Uren',
        actor: { column: 'Column 3', targetTypes: ['Principal', 'Identity'] },
        subject: { column: 'Column 4', targetType: 'OrgEntity', targetEntityType: 'Klant' },
        when: { yearColumn: 'Column 1', monthColumn: 'Column 2' },
        measure: { column: 'Column 5' },
        attributes: [],
      },
    });
  });

  it('a staff xlsx is ENRICHMENT of identities: keyed on the address, expertises multi-valued', async () => {
    const { chosen, proposal, columns } = await discover(await xlsx(STAFF), 'Maten.xlsx');
    expect(chosen.summary.kind).toBe('enrichment');
    expect(chosen.summary.confidence).toBe(0.85);
    const { recipe, linkRules } = proposal;
    expect(recipe.template).toBe('enrichment');
    expect(recipe.enrich).toEqual({ targetType: 'Identity' });
    expect(recipe.entities).toHaveLength(1);
    expect(recipe.entities[0]).toMatchObject({ type: 'Maten', nameColumn: 'Volledige naam', keyColumn: 'E-mail' });
    expect(recipe.entities[0].attributes.filter(a => a.multi).map(a => a.column)).toEqual(['Expertises']);
    expect(linkRules).toHaveLength(1);
    expect(linkRules[0]).toMatchObject({ entityType: 'Maten', targetType: 'Identity', via: 'displayName' });
    expect(linkRules[0].signals.map(s => `${s.attribute}:${s.targetField}`)).toContain('eMail:email');
    expect(validateRecipe(recipe, columns.map(c => c.name)).ok).toBe(true);
    expect(validateLinkRules(linkRules, recipe).ok).toBe(true);
  });

  it('a SharePoint customer/teams xlsx stays a COLLECTION, with the heuristic\'s member rules', async () => {
    const { chosen, proposal } = await discover(await xlsx(CUSTOMERS), 'Klanten.xlsx');
    expect(chosen.summary.kind).toBe('collection');
    expect(chosen.summary.confidence).toBe(0.5);
    expect(chosen.summary.alternatives).toEqual(['enrichment', 'activity', 'relation']);
    expect(proposal.recipe.template).toBe('collection');
    expect(proposal.recipe.entities[0].nameColumn).toBe('Title');
    expect(proposal.linkRules.map(r => r.via)).toEqual(expect.arrayContaining(['eigenaar', 'team']));
  });

  it('a list of pairs is RELATION', async () => {
    const { chosen, proposal } = await discover(Buffer.from(SOD), 'SoD.csv');
    expect(chosen.summary.kind).toBe('relation');
    expect(proposal.recipe.relation).toMatchObject({ left: { column: 'Recht A', targetType: 'Resource' }, right: { column: 'Recht B', targetType: 'Resource' } });
    expect(proposal.linkRules.map(r => r.via)).toEqual(['left', 'right']);
  });

  it('the wizard can force another kind: the timesheet as a collection, the staff list as activity', async () => {
    const asCollection = await discover(Buffer.from(TIMESHEET), 'Uren.csv', 'collection');
    expect(asCollection.proposal.template.kind).toBe('collection');
    expect(asCollection.proposal.recipe.entities).toHaveLength(1);
    expect(asCollection.proposal.template.alternatives[0]).toBe('activity');
    const asActivity = await discover(await xlsx(STAFF), 'Maten.xlsx', 'activity');
    expect(asActivity.proposal.template).toMatchObject({ kind: 'activity', confidence: 0 });
    expect(asActivity.proposal.template.reason).toMatch(/You chose activity/);
    expect(asActivity.proposal.recipe.template).toBe('activity');
  });
});

describe('column features', () => {
  const col = (name, shape, samples, over = {}) => ({ name, shape, samples, nonEmpty: 10, distinct: 5, uniqueness: 0.5, index: 0, ...over });

  it('a year column holds only years; a month column month names (or numbers under a month header)', () => {
    expect(isYearColumn(col('Y', 'number', ['2025', '2026']))).toBe(true);
    expect(isYearColumn(col('Y', 'number', ['2025', '26']))).toBe(false);
    expect(isYearColumn(col('Y', 'number', []))).toBe(false);
    expect(isMonthColumn(col('M', 'text', ['maart', 'April']))).toBe(true);
    expect(isMonthColumn(col('M', 'number', ['3', '4']))).toBe(false);
    expect(isMonthColumn(col('Maand', 'number', ['3', '4']))).toBe(true);
    expect(isMonthColumn(col('M', 'text', ['maart', 'Contoso']))).toBe(false);
  });

  it('a measure is a number with decimals or a measure header, never a year or month', () => {
    expect(isMeasureColumn(col('C5', 'number', ['8', '7,5']))).toBe(true);
    expect(isMeasureColumn(col('Uren', 'number', ['8', '7']))).toBe(true);
    expect(isMeasureColumn(col('Code', 'number', ['8', '7']))).toBe(false);
    expect(isMeasureColumn(col('Uren', 'text', ['8,5']))).toBe(false);
    expect(isMeasureColumn(col('Jaar', 'number', ['2026']))).toBe(false);
  });

  it('people: the probe decides when there is one, else the header or e-mail values', () => {
    expect(namesPeople(col('X', 'text', []), { X: { people: 0.5 } })).toBe(true);
    expect(namesPeople(col('X', 'text', []), { X: { people: 0.49 } })).toBe(false);
    expect(namesPeople(col('Eigenaar', 'text', []), { Eigenaar: { people: 0 } })).toBe(false);
    expect(namesPeople(col('Eigenaar', 'text', []), null)).toBe(true);
    expect(namesPeople(col('Mail', 'email', []), null)).toBe(true);
    expect(namesPeople(col('Note', 'text', []), null)).toBe(false);
  });
});

describe('evaluations on column profiles', () => {
  const c = (name, shape, samples, over = {}) => ({ name, shape, samples, nonEmpty: 10, distinct: 4, uniqueness: 0.4, index: 0, ...over });
  const probe = (people = 0, orgEntities = 0, resources = 0) => ({ people, orgEntities, resources, orgEntityTypes: orgEntities ? ['Klant'] : [] });

  it('activity needs time, measure, an actor and a subject; an unprobed subject is less sure', () => {
    const cols = [c('Datum', 'date', ['2026-03-01']), c('Wie', 'text', ['Ann']), c('Wat', 'text', ['Contoso']), c('Uren', 'number', ['7,5'])];
    expect(evaluateActivity(cols, { Wie: probe(0.9), Wat: probe(0, 0.8) })).toMatchObject({ ok: true, confidence: 0.9 });
    expect(evaluateActivity(cols, { Wie: probe(0.9), Wat: probe(0, 0.1) })).toMatchObject({ ok: true, confidence: 0.7 });
    expect(evaluateActivity(cols, { Wie: probe(0.1), Wat: probe(0, 0.8) }).ok).toBe(false);
    expect(evaluateActivity(cols.filter(x => x.name !== 'Uren'), { Wie: probe(0.9), Wat: probe(0, 0.8) }).ok).toBe(false);
    expect(evaluateActivity(cols.filter(x => x.name !== 'Datum'), { Wie: probe(0.9), Wat: probe(0, 0.8) }).ok).toBe(false);
    // the only other text column is all-unique and not a reference: no subject
    const noSubject = [cols[0], cols[1], c('Wat', 'text', ['x'], { distinct: 10, uniqueness: 1 }), cols[3]];
    expect(evaluateActivity(noSubject, { Wie: probe(0.9), Wat: probe(0) }).ok).toBe(false);
  });

  it('relation: exactly two reference columns, at most one other, not both unique', () => {
    const a = c('A', 'text', ['x']); const b = c('B', 'text', ['y']);
    const p = { A: probe(0, 0, 0.9), B: probe(0, 0, 0.9) };
    expect(evaluateRelation([a, b, c('Why', 'text', ['z'])], p).ok).toBe(true);
    expect(evaluateRelation([a, b, c('Why', 'text', ['z']), c('More', 'text', ['z'])], p).ok).toBe(false);
    expect(evaluateRelation([a, b], { A: probe(0, 0, 0.9) }).ok).toBe(false);
    const unique = { uniqueness: 1, distinct: 10 };
    expect(evaluateRelation([c('A', 'text', ['x'], unique), c('B', 'text', ['y'], unique)], p).ok).toBe(false);
    expect(evaluateRelation([c('A', 'text', ['x'], unique), b], p).ok).toBe(true);
  });

  it('enrichment: a unique people (or resource) column on nearly every row, something to add, no team column', () => {
    const name = c('Volledige naam', 'text', ['Ann'], { uniqueness: 1, distinct: 10 });
    const skills = c('Skills', 'text', ['IAM, Azure']);
    expect(evaluateEnrichment([name, skills], { 'Volledige naam': probe(0.9) }, 10)).toMatchObject({ ok: true, picks: { targetKind: 'person' } });
    expect(evaluateEnrichment([name, skills], null, 10)).toMatchObject({ ok: true, confidence: 0.6 });
    expect(evaluateEnrichment([name, skills], { 'Volledige naam': probe(0.9) }, 12).ok).toBe(false);
    expect(evaluateEnrichment([name], { 'Volledige naam': probe(0.9) }, 10).ok).toBe(false);
    const team = c('Team', 'text', ['Ann;#1;#Bob;#2']);
    expect(evaluateEnrichment([name, skills, team], { 'Volledige naam': probe(0.9), Team: probe(0.9) }, 10).ok).toBe(false);
    const group = c('Groep', 'text', ['SG_A'], { uniqueness: 1, distinct: 10 });
    expect(evaluateEnrichment([group, skills], { Groep: probe(0, 0, 0.8) }, 10)).toMatchObject({ ok: true, picks: { targetKind: 'resource' } });
  });

  it('an unknown forced template is ignored; the detected one stands', () => {
    const r = chooseTemplate({ columns: [c('Naam', 'text', ['x'])], forced: 'timesheet' });
    expect(r.kind).toBe('collection');
    expect(r.summary.reason).toMatch(/thing of its own/);
  });
});

describe('a team column is never an enrichment key', () => {
  it('unique team cells listing people do not make the list an enrichment', () => {
    const team = { name: 'Team', shape: 'text', samples: ['Ann;#1;#Bob;#2', 'Cas;#3'], nonEmpty: 2, distinct: 2, uniqueness: 1, index: 0 };
    const note = { name: 'Note', shape: 'text', samples: ['x'], nonEmpty: 2, distinct: 1, uniqueness: 0.5, index: 1 };
    expect(evaluateEnrichment([team, note], { Team: { people: 1, orgEntities: 0, resources: 0, orgEntityTypes: [] } }, 2).ok).toBe(false);
  });
});

describe('propose — a forced template without probes', () => {
  it('builds that template\'s recipe from the column profile alone, without asking the model', async () => {
    const columns = [
      { name: 'A', shape: 'text', samples: ['x'], nonEmpty: 2, distinct: 1, uniqueness: 0.5 },
      { name: 'B', shape: 'text', samples: ['y'], nonEmpty: 2, distinct: 1, uniqueness: 0.5 },
    ];
    const out = await propose({ fileName: 'pairs.csv', columns, template: 'relation' });
    expect(out.origin).toBe('heuristic');
    expect(out.timing.model).toBe(false);
    expect(out.template.kind).toBe('relation');
    expect(out.recipe.relation).toMatchObject({ left: { column: 'A' }, right: { column: 'B' } });
  });
});
