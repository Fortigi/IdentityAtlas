import { describe, it, expect } from 'vitest';
import { validateRecipe, validateLinkRules, normalizeRecipe } from './contracts.js';
import { relationEntityDef, RELATION_NAME_COLUMN, MAX_EXTRA_ATTRIBUTES } from './templateContracts.js';

const COLS = ['Year', 'Month', 'Person', 'Customer', 'Hours', 'Note', 'Date', 'A', 'B', 'Reason', 'Name', 'Mail', 'Skills'];
const errorsOf = (recipe, cols = COLS) => validateRecipe(recipe, cols).errors;

const activity = (over = {}) => ({
  version: 1, template: 'activity',
  activity: {
    type: 'Hours',
    actor: { column: 'Person', targetTypes: ['Principal', 'Identity'] },
    subject: { column: 'Customer', targetType: 'OrgEntity', targetEntityType: 'Customer' },
    when: { yearColumn: 'Year', monthColumn: 'Month' },
    measure: { column: 'Hours', unit: 'h' },
    attributes: [{ column: 'Note', name: 'note' }],
    ...over,
  },
});

const relation = (over = {}) => ({
  version: 1, template: 'relation',
  relation: {
    type: 'Incompatibility', predicate: 'incompatibleWith',
    left: { column: 'A', targetType: 'Resource' },
    right: { column: 'B', targetType: 'Resource' },
    attributes: [{ column: 'Reason' }],
    ...over,
  },
});

const enrichment = (over = {}) => ({
  version: 1, template: 'enrichment', enrich: { targetType: 'Identity' },
  entities: [{ type: 'Staff', nameColumn: 'Name', keyColumn: 'Mail', attributes: [{ column: 'Skills', name: 'skills', multi: true }] }],
  relations: [],
  ...over,
});

describe('validateRecipe — template selection', () => {
  it('a recipe without template is a collection, as before', () => {
    expect(validateRecipe({ version: 1, entities: [{ type: 'Project', nameColumn: 'Name' }], relations: [] }, COLS)).toEqual({ ok: true, errors: [] });
  });
  it('refuses an unknown template, and says which exist', () => {
    expect(errorsOf({ version: 1, template: 'timesheet' })).toEqual(['The recipe "template" must be one of collection, enrichment, activity, relation.']);
    expect(errorsOf({ version: 2, template: 'x' })).toHaveLength(2);
  });
});

describe('activity recipe', () => {
  it('accepts the handover shape (year + month) and the date shape', () => {
    expect(errorsOf(activity())).toEqual([]);
    expect(errorsOf(activity({ when: { dateColumn: 'Date' }, measure: undefined, attributes: undefined }))).toEqual([]);
    expect(errorsOf(activity({ subject: { column: 'Customer', targetType: 'Resource' } }))).toEqual([]);
  });

  it('needs the activity object and each part', () => {
    expect(errorsOf({ version: 1, template: 'activity' })).toEqual(['An activity recipe needs an "activity" object.']);
    const e = errorsOf({ version: 1, template: 'activity', activity: { type: ' ' } });
    expect(e).toEqual([
      'The activity "type" is missing.',
      'The activity needs an "actor": { column, targetTypes }.',
      'The activity needs a "subject": { column, targetType }.',
      'The activity needs a "when": { dateColumn } or { yearColumn, monthColumn }.',
    ]);
  });

  it('checks every column against the source', () => {
    const e = errorsOf(activity({ actor: { column: 'Who', targetTypes: ['Principal'] }, measure: { column: 'Uren' } }));
    expect(e).toEqual([
      'The activity actor refers to column "Who", which the source does not have.',
      'The activity measure refers to column "Uren", which the source does not have.',
    ]);
  });

  it('actor target types: one or both of Principal/Identity, no repeats, nothing else', () => {
    for (const targetTypes of [[], ['Resource'], ['Principal', 'Principal'], 'Principal']) {
      expect(errorsOf(activity({ actor: { column: 'Person', targetTypes } }))).toEqual(['The activity actor "targetTypes" must list one or both of Principal, Identity.']);
    }
    expect(errorsOf(activity({ actor: { column: 'Person', targetTypes: ['Identity'] } }))).toEqual([]);
    expect(errorsOf(activity({ actor: { targetTypes: ['Identity'] } }))).toEqual(['The activity actor names no column.']);
  });

  it('subject: OrgEntity or Resource; targetEntityType only with OrgEntity', () => {
    expect(errorsOf(activity({ subject: { column: 'Customer', targetType: 'Principal' } }))).toEqual(['The activity subject "targetType" must be one of OrgEntity, Resource.']);
    expect(errorsOf(activity({ subject: { column: 'Customer', targetType: 'Resource', targetEntityType: 'Customer' } })))
      .toEqual(['The activity subject "targetEntityType" only goes with targetType OrgEntity.']);
    expect(errorsOf(activity({ subject: { column: 'Customer', targetType: 'OrgEntity', targetEntityType: '' } })))
      .toEqual(['The activity subject "targetEntityType" is missing.']);
    expect(errorsOf(activity({ subject: { column: 'Customer', targetType: 'OrgEntity', targetEntityType: 'x'.repeat(65) } })))
      .toEqual(['The activity subject "targetEntityType" is longer than 64 characters.']);
  });

  it('when: a date, or a year with a month, never both', () => {
    expect(errorsOf(activity({ when: { dateColumn: 'Date', yearColumn: 'Year' } }))).toEqual(['The activity "when" is either a dateColumn or a yearColumn with a monthColumn, not both.']);
    expect(errorsOf(activity({ when: { dateColumn: 'Date', monthColumn: 'Month' } }))).toHaveLength(1);
    expect(errorsOf(activity({ when: { yearColumn: 'Year' } }))).toEqual(['The activity month names no column.']);
    expect(errorsOf(activity({ when: {} }))).toEqual(['The activity year names no column.', 'The activity month names no column.']);
  });

  it('measure: an object with a column and a short unit', () => {
    expect(errorsOf(activity({ measure: 'Hours' }))).toEqual(['The activity "measure" must be { column, unit? }.']);
    expect(errorsOf(activity({ measure: { column: 'Hours', unit: 'x'.repeat(17) } }))).toEqual(['The activity measure "unit" must be a short text (at most 16 characters).']);
    expect(errorsOf(activity({ measure: { column: 'Hours', unit: 'x'.repeat(16) } }))).toEqual([]);
    expect(errorsOf(activity({ measure: { column: 'Hours', unit: 7 } }))).toHaveLength(1);
  });

  it('extra attributes: an array of mapped columns, each name once, at most the maximum', () => {
    expect(errorsOf(activity({ attributes: 'Note' }))).toEqual(['The activity "attributes" must be an array.']);
    expect(errorsOf(activity({ attributes: [{ name: 'x' }] }))).toEqual(['The activity has an attribute without a "column".']);
    expect(errorsOf(activity({ attributes: [{ column: 'Note' }, { column: 'Date', name: 'Note' }] }))).toEqual(['The activity maps attribute "Note" twice (or uses a reserved name).']);
    const many = Array.from({ length: MAX_EXTRA_ATTRIBUTES + 1 }, (_, i) => ({ column: 'Note', name: `n${i}` }));
    expect(errorsOf(activity({ attributes: many }))).toEqual([`The activity has ${MAX_EXTRA_ATTRIBUTES + 1} attributes; the maximum is ${MAX_EXTRA_ATTRIBUTES}.`]);
    expect(errorsOf(activity({ attributes: many.slice(1) }))).toEqual([]);
  });

  it('normalises: trimmed type, the when shape it uses, the unit only when given, attribute names defaulted', () => {
    expect(normalizeRecipe(activity({ type: ' Hours ', attributes: [{ column: 'Note' }] }))).toEqual({
      version: 1, template: 'activity',
      activity: {
        type: 'Hours',
        actor: { column: 'Person', targetTypes: ['Principal', 'Identity'] },
        subject: { column: 'Customer', targetType: 'OrgEntity', targetEntityType: 'Customer' },
        when: { yearColumn: 'Year', monthColumn: 'Month' },
        measure: { column: 'Hours', unit: 'h' },
        attributes: [{ column: 'Note', name: 'Note' }],
      },
    });
    const n = normalizeRecipe(activity({ when: { dateColumn: 'Date' }, measure: { column: 'Hours', unit: ' ' }, attributes: undefined, subject: { column: 'Customer', targetType: 'Resource' } }));
    expect(n.activity.when).toEqual({ dateColumn: 'Date' });
    expect(n.activity.measure).toEqual({ column: 'Hours' });
    expect(n.activity.attributes).toEqual([]);
    expect(n.activity.subject).toEqual({ column: 'Customer', targetType: 'Resource' });
    expect('measure' in normalizeRecipe(activity({ measure: undefined })).activity).toBe(false);
  });

  it('has no link rules', () => {
    expect(validateLinkRules([], activity()).ok).toBe(true);
    const rule = { entityType: 'Hours', targetType: 'Principal', signals: [{ attribute: 'displayName', targetField: 'email', type: 'exact', weight: 90 }] };
    expect(validateLinkRules([rule], activity()).errors[0]).toBe('An activity import has no link rules: its actor and subject columns are matched per distinct value.');
  });
});

describe('relation recipe', () => {
  it('accepts the handover shape', () => {
    expect(errorsOf(relation())).toEqual([]);
    expect(errorsOf(relation({ left: { column: 'A', targetType: 'OrgEntity', targetEntityType: 'Customer' }, attributes: undefined }))).toEqual([]);
  });

  it('needs the relation object, type, predicate and two ends', () => {
    expect(errorsOf({ version: 1, template: 'relation', relation: [] })).toEqual(['A relation recipe needs a "relation" object.']);
    expect(errorsOf({ version: 1, template: 'relation', relation: { type: 'X' } })).toEqual([
      'The relation "predicate" is missing.',
      'The relation needs a "left": { column, targetType }.',
      'The relation needs a "right": { column, targetType }.',
    ]);
  });

  it('each end: a column of the source and a target type of the four', () => {
    expect(errorsOf(relation({ right: { column: 'C', targetType: 'Context' } }))).toEqual([
      'The relation right end refers to column "C", which the source does not have.',
      'The relation right end "targetType" must be one of Resource, Principal, Identity, OrgEntity.',
    ]);
    expect(errorsOf(relation({ left: { column: 'A', targetType: 'Principal', targetEntityType: 'T' } }))).toEqual(['The relation left end "targetEntityType" only goes with targetType OrgEntity.']);
  });

  it('the two ends are different columns, and no extra attribute is called left or right', () => {
    expect(errorsOf(relation({ right: { column: 'A', targetType: 'Resource' } }))).toEqual(['The relation\'s left and right ends must be different columns.']);
    expect(errorsOf(relation({ attributes: [{ column: 'Reason', name: 'left' }] }))).toEqual(['The relation maps attribute "left" twice (or uses a reserved name).']);
  });

  it('normalises with trimmed names and defaulted attribute names', () => {
    expect(normalizeRecipe(relation({ type: ' SoD ', predicate: ' incompatibleWith ' }))).toEqual({
      version: 1, template: 'relation',
      relation: {
        type: 'SoD', predicate: 'incompatibleWith',
        left: { column: 'A', targetType: 'Resource' }, right: { column: 'B', targetType: 'Resource' },
        attributes: [{ column: 'Reason', name: 'Reason' }],
      },
    });
  });

  it('is one entity in the collection shape: named by a generated column, keyed on both ends, the ends as left/right', () => {
    expect(relationEntityDef(normalizeRecipe(relation()).relation)).toEqual({
      type: 'Incompatibility', nameColumn: RELATION_NAME_COLUMN, keyColumn: RELATION_NAME_COLUMN, keyColumns: ['A', 'B'],
      attributes: [{ column: 'A', name: 'left' }, { column: 'B', name: 'right' }, { column: 'Reason', name: 'Reason' }],
    });
  });

  it('link rules are checked against that entity: via left/right exists, another attribute does not', () => {
    const rule = (via) => ({ entityType: 'Incompatibility', targetType: 'Resource', via, signals: [{ attribute: via, targetField: 'displayName', type: 'exact', weight: 90 }] });
    expect(validateLinkRules([rule('left'), rule('right')], relation()).errors).toEqual([]);
    expect(validateLinkRules([rule('middle')], relation()).errors[0]).toMatch(/links via "middle", which entity "Incompatibility" does not have/);
    // an incomplete relation recipe has no entity to check against
    expect(validateLinkRules([rule('left')], { template: 'relation', relation: { type: 'Incompatibility' } }).errors[0]).toMatch(/which the recipe does not define/);
  });
});

describe('enrichment recipe', () => {
  it('accepts one entity with a target type and multi-valued attributes', () => {
    expect(errorsOf(enrichment())).toEqual([]);
  });

  it('runs the collection checks too', () => {
    expect(errorsOf(enrichment({ entities: [{ type: 'Staff', nameColumn: 'Nope' }] }))).toEqual(['Entity "Staff" nameColumn refers to column "Nope", which the source does not have.']);
  });

  it('exactly one entity, no relations, a target type of the three', () => {
    const two = enrichment({ entities: [{ type: 'A', nameColumn: 'Name' }, { type: 'B', nameColumn: 'Mail' }], relations: [{ predicate: 'p', from: 'A', to: 'B' }] });
    expect(errorsOf(two)).toEqual([
      'An enrichment describes exactly one list of things, so its recipe has exactly one entity.',
      'An enrichment has no relations between entity types.',
    ]);
    expect(errorsOf(enrichment({ enrich: { targetType: 'OrgEntity' } }))).toEqual(['An enrichment needs "enrich.targetType": one of Identity, Principal, Resource.']);
    expect(errorsOf(enrichment({ enrich: undefined }))).toHaveLength(1);
  });

  it('multi is true or false', () => {
    const e = enrichment({ entities: [{ type: 'Staff', nameColumn: 'Name', attributes: [{ column: 'Skills', multi: 'yes' }] }] });
    expect(errorsOf(e)).toEqual(['Attribute "Skills" "multi" must be true or false.']);
  });

  it('normalises: template, target, one entity, multi kept only when true', () => {
    const n = normalizeRecipe(enrichment({ entities: [{ type: 'Staff', nameColumn: 'Name', keyColumn: 'Mail', attributes: [{ column: 'Skills', name: 'skills', multi: true }, { column: 'Note', multi: false }] }] }));
    expect(n).toEqual({
      version: 1, template: 'enrichment', enrich: { targetType: 'Identity' },
      entities: [{ type: 'Staff', nameColumn: 'Name', keyColumn: 'Mail', attributes: [{ column: 'Skills', name: 'skills', multi: true }, { column: 'Note', name: 'Note' }] }],
      relations: [],
    });
  });

  it('needs a link rule to its target type; other rules may come on top', () => {
    const toIdentity = { entityType: 'Staff', targetType: 'Identity', signals: [{ attribute: 'displayName', targetField: 'displayName', type: 'exact', weight: 80 }] };
    const toResource = { ...toIdentity, targetType: 'Resource' };
    expect(validateLinkRules([toIdentity, toResource], enrichment()).errors).toEqual([]);
    expect(validateLinkRules([toResource], enrichment()).errors).toEqual(['An enrichment needs a link rule from "Staff" to Identity: it says which Identity each row adds information to.']);
    expect(validateLinkRules([], enrichment()).errors).toHaveLength(1);
  });
});
