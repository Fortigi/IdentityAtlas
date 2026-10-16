// The four import templates: defaults, section edits, targets, readiness, and
// the exact recipe JSON the API receives per template. Inputs discriminate:
// two attribute rows so a wrong-index edit shows, a collection end next to a
// Resource end so a swapped target shows, year+month next to a date column.
import { describe, it, expect } from 'vitest';
import * as T from './templateDraft';

const activityRecipe = (patch = {}) => T.withTemplateDefaults({
  template: 'activity',
  activity: {
    type: ' Hours ', actor: { column: 'Employee', targetTypes: ['Principal', 'Identity'] },
    subject: { column: 'Customer', targetType: 'OrgEntity', targetEntityType: 'Client' },
    when: { yearColumn: 'Year', monthColumn: 'Month' }, measure: { column: 'Hours', unit: ' h ' },
    attributes: [{ column: 'Project', name: ' project ' }, { column: '', name: 'dropped' }],
    ...patch,
  },
});

const relationRecipe = () => T.withTemplateDefaults({
  template: 'relation',
  relation: {
    type: 'Incompatibility', predicate: 'incompatibleWith',
    left: { column: 'Role A', targetType: 'Resource' },
    right: { column: 'Role B', targetType: 'OrgEntity', targetEntityType: 'Application' },
    attributes: [{ column: 'Reason', name: '' }],
  },
});

describe('templateOf / linksTemplate', () => {
  it('reads the recipe template; absent or unknown is a collection', () => {
    expect(T.templateOf({ template: 'activity' })).toBe('activity');
    expect(T.templateOf({ template: 'relation' })).toBe('relation');
    expect(T.templateOf({})).toBe('collection');
    expect(T.templateOf({ template: 'timesheet' })).toBe('collection');
    expect(T.templateOf(null)).toBe('collection');
  });

  it('only collection and enrichment carry link rules', () => {
    expect(T.TEMPLATE_KINDS.filter(T.linksTemplate)).toEqual(['collection', 'enrichment']);
  });

  it('has a card for every kind, in the fixed order', () => {
    expect(T.TEMPLATE_KINDS).toEqual(['collection', 'enrichment', 'activity', 'relation']);
    expect(T.TEMPLATE_KINDS.map(k => T.TEMPLATE_CARDS[k].label)).toEqual(['Collection', 'Enrichment', 'Activity', 'Relation']);
  });
});

describe('withTemplateDefaults', () => {
  it('a collection loses any template key and keeps its entities', () => {
    const r = T.withTemplateDefaults({ template: 'collection', entities: [{ type: 'Project' }], relations: [] });
    expect(r).toEqual({ version: 1, entities: [{ type: 'Project' }], relations: [] });
  });

  it('an empty activity has every part, people as actors and a date column', () => {
    expect(T.emptyTemplateRecipe('activity')).toEqual({
      version: 1, entities: [], relations: [], template: 'activity',
      activity: {
        type: '', actor: { column: '', targetTypes: ['Principal', 'Identity'] }, subject: { column: '', targetType: 'Resource' },
        when: { dateColumn: '' }, measure: { column: '', unit: '' }, attributes: [],
      },
    });
  });

  it('a partial activity proposal keeps what it said and fills the rest', () => {
    const r = T.withTemplateDefaults({ template: 'activity', activity: { type: 'Hours', subject: { column: 'Customer' }, when: { yearColumn: 'Y', monthColumn: 'M' } } });
    expect(r.activity.subject).toEqual({ column: 'Customer', targetType: 'Resource' });
    expect(r.activity.actor).toEqual({ column: '', targetTypes: ['Principal', 'Identity'] });
    expect(r.activity.when).toEqual({ yearColumn: 'Y', monthColumn: 'M' });
    expect(r.activity.measure).toEqual({ column: '', unit: '' });
    expect(r.activity.type).toBe('Hours');
  });

  it('an enrichment gets one empty entity and Identity as its target unless it has them', () => {
    const empty = T.emptyTemplateRecipe('enrichment');
    expect(empty.entities).toEqual([{ type: '', nameColumn: '', keyColumn: '', nameAttribute: '', attributes: [] }]);
    expect(empty.enrich).toEqual({ targetType: 'Identity' });
    const kept = T.withTemplateDefaults({ template: 'enrichment', entities: [{ type: 'Expertise' }], enrich: { targetType: 'Resource' } });
    expect(kept.entities).toEqual([{ type: 'Expertise' }]);
    expect(kept.enrich).toEqual({ targetType: 'Resource' });
  });

  it('a relation fills both ends and keeps a given end', () => {
    const r = T.withTemplateDefaults({ relation: { left: { column: 'A', targetType: 'Principal' } } }, 'relation');
    expect(r.template).toBe('relation');
    expect(r.relation.left).toEqual({ column: 'A', targetType: 'Principal' });
    expect(r.relation.right).toEqual({ column: '', targetType: 'Resource' });
    expect(r.relation.attributes).toEqual([]);
  });
});

describe('section edits', () => {
  it('patchPart changes one part and leaves its siblings', () => {
    const r = T.patchPart(activityRecipe(), 'activity', 'measure', { unit: 'days' });
    expect(r.activity.measure).toEqual({ column: 'Hours', unit: 'days' });
    expect(r.activity.actor.column).toBe('Employee');
  });

  it('setWhenMode switches the shape and leaves the same mode alone', () => {
    const r = activityRecipe();
    expect(T.whenMode(r.activity.when)).toBe('yearMonth');
    expect(T.setWhenMode(r, 'yearMonth')).toBe(r);
    const dated = T.setWhenMode(r, 'date');
    expect(dated.activity.when).toEqual({ dateColumn: '' });
    expect(T.setWhenMode(dated, 'yearMonth').activity.when).toEqual({ yearColumn: '', monthColumn: '' });
    expect(T.whenMode({ monthColumn: 'M' })).toBe('yearMonth');
    expect(T.whenMode(undefined)).toBe('date');
  });

  it('attribute rows: add, update the right row, ignore a missing row, remove the right row', () => {
    const r = T.addSectionAttribute(activityRecipe(), 'activity');
    expect(r.activity.attributes).toHaveLength(3);
    expect(r.activity.attributes[2]).toEqual({ column: '', name: '' });
    const u = T.updateSectionAttribute(r, 'activity', 1, { column: 'Task' });
    expect(u.activity.attributes.map(a => a.column)).toEqual(['Project', 'Task', '']);
    expect(T.updateSectionAttribute(r, 'activity', 9, { column: 'X' })).toBe(r);
    expect(T.removeSectionAttribute(u, 'activity', 0).activity.attributes.map(a => a.column)).toEqual(['Task', '']);
  });
});

describe('targets', () => {
  it('encodes a collection end as OrgEntity:<type> and a system end as its type', () => {
    expect(T.targetValue({ targetType: 'OrgEntity', targetEntityType: 'Client' })).toBe('OrgEntity:Client');
    expect(T.targetValue({ targetType: 'OrgEntity' })).toBe('');
    expect(T.targetValue({ targetType: 'Resource' })).toBe('Resource');
    expect(T.targetValue(undefined)).toBe('');
    expect(T.parseTarget('OrgEntity:Client')).toEqual({ targetType: 'OrgEntity', targetEntityType: 'Client' });
    expect(T.parseTarget('Resource')).toEqual({ targetType: 'Resource' });
  });

  it('setTarget keeps the column and drops a collection type when Resource is picked', () => {
    const r = T.setTarget(activityRecipe(), 'activity', 'subject', 'Resource');
    expect(r.activity.subject).toEqual({ column: 'Customer', targetType: 'Resource' });
    expect(T.setTarget(r, 'activity', 'subject', 'OrgEntity:Project').activity.subject)
      .toEqual({ column: 'Customer', targetType: 'OrgEntity', targetEntityType: 'Project' });
  });

  it('collectionTypes keeps collections and types without a template', () => {
    const model = { entityTypes: [
      { type: 'Client', template: 'collection' }, { type: 'Expertise', template: 'enrichment' },
      { type: 'Project' }, { type: 'Hours', template: 'activity' }, { type: '  ' },
    ] };
    expect(T.collectionTypes(model)).toEqual(['Client', 'Project']);
    expect(T.collectionTypes(null)).toEqual([]);
  });

  it('targetOptions lists the system types, the collections, and a chosen collection /model did not list', () => {
    expect(T.targetOptions(['Resource'], ['Client'], { targetType: 'OrgEntity', targetEntityType: 'Asset' })).toEqual([
      { value: 'Resource', label: 'Resource' },
      { value: 'OrgEntity:Client', label: 'Client (collection)' },
      { value: 'OrgEntity:Asset', label: 'Asset (collection)' },
    ]);
    expect(T.targetOptions(['Resource'], ['Client'], { targetType: 'OrgEntity', targetEntityType: 'Client' })).toHaveLength(2);
    expect(T.targetOptions(['Resource'], [], { targetType: 'Resource' })).toEqual([{ value: 'Resource', label: 'Resource' }]);
  });
});

describe('readiness', () => {
  it('a complete activity has no problems', () => {
    expect(T.activityProblems(activityRecipe().activity)).toEqual([]);
  });

  it('names each missing activity part', () => {
    const a = T.emptyTemplateRecipe('activity').activity;
    expect(T.activityProblems(a)).toEqual([
      'Name the activity, e.g. Hours.',
      'Choose the actor column.',
      'Choose the subject column.',
      'Choose when each row happened: a date column, or a year and a month column.',
    ]);
    const collectionWithoutType = { ...activityRecipe().activity, subject: { column: 'Customer', targetType: 'OrgEntity' } };
    expect(T.activityProblems(collectionWithoutType)).toEqual(['Choose what the subject column refers to.']);
    const halfMonth = { ...activityRecipe().activity, when: { yearColumn: 'Year', monthColumn: '' } };
    expect(T.activityProblems(halfMonth)).toEqual(['Choose when each row happened: a date column, or a year and a month column.']);
    expect(T.activityProblems({ ...activityRecipe().activity, when: { dateColumn: 'Date' } })).toEqual([]);
  });

  it('names each missing relation part, per side', () => {
    expect(T.relationProblems(relationRecipe().relation)).toEqual([]);
    const r = { ...relationRecipe().relation, predicate: ' ', right: { column: '', targetType: 'OrgEntity' } };
    expect(T.relationProblems(r)).toEqual([
      'Say how the left side relates to the right, e.g. incompatibleWith.',
      'Choose the right column.',
      'Choose what the right column refers to.',
    ]);
    expect(T.relationProblems(T.emptyTemplateRecipe('relation').relation)[0]).toBe('Name the relation, e.g. Incompatibility.');
  });

  it('an enrichment needs exactly one list, a known target, a name and a key column', () => {
    const ok = { entities: [{ type: 'Expertise', nameColumn: 'Email' }], enrich: { targetType: 'Principal' } };
    expect(T.enrichmentProblems(ok)).toEqual([]);
    expect(T.enrichmentProblems({ ...ok, entities: [...ok.entities, { type: 'B', nameColumn: 'B' }] })).toEqual(['An enrichment describes exactly one list.']);
    expect(T.enrichmentProblems({ ...ok, enrich: { targetType: 'OrgEntity' } })).toEqual(['Choose what the list adds information to.']);
    expect(T.enrichmentProblems({ entities: [], enrich: {} })).toEqual([
      'An enrichment describes exactly one list.', 'Choose what the list adds information to.',
      'Name the list, e.g. Expertise.', 'Choose the key column: the values that identify who or what each row is about.',
    ]);
  });

  it('sectionColumns lists what an activity or relation reads; nothing for the others', () => {
    expect(T.sectionColumns(activityRecipe())).toEqual(['Employee', 'Customer', 'Year', 'Month', 'Hours', 'Project', '']);
    expect(T.sectionColumns(relationRecipe())).toEqual(['Role A', 'Role B', 'Reason']);
    expect(T.sectionColumns({ entities: [] })).toEqual([]);
  });
});

describe('what the API receives', () => {
  it('an activity with year + month, a collection subject, a trimmed unit and named attributes', () => {
    expect(T.activityForApi(activityRecipe().activity)).toEqual({
      type: 'Hours',
      actor: { column: 'Employee', targetTypes: ['Principal', 'Identity'] },
      subject: { column: 'Customer', targetType: 'OrgEntity', targetEntityType: 'Client' },
      when: { yearColumn: 'Year', monthColumn: 'Month' },
      measure: { column: 'Hours', unit: 'h' },
      attributes: [{ column: 'Project', name: 'project' }],
    });
  });

  it('an activity with a date column, a Resource subject, no measure and no actor types defaults them', () => {
    const a = activityRecipe({
      actor: { column: 'Employee', targetTypes: [] }, subject: { column: 'Group', targetType: 'Resource', targetEntityType: 'stale' },
      when: { dateColumn: 'Date', yearColumn: 'ignored' }, measure: { column: '', unit: 'h' }, attributes: [],
    }).activity;
    expect(T.activityForApi({ ...a, when: { dateColumn: 'Date' } })).toEqual({
      type: 'Hours', actor: { column: 'Employee', targetTypes: ['Principal', 'Identity'] },
      subject: { column: 'Group', targetType: 'Resource' }, when: { dateColumn: 'Date' }, attributes: [],
    });
    expect(T.activityForApi({ ...a, measure: { column: 'Hours', unit: ' ' } }).measure).toEqual({ column: 'Hours' });
  });

  it('a relation with a Resource end and a collection end', () => {
    expect(T.relationForApi(relationRecipe().relation)).toEqual({
      type: 'Incompatibility', predicate: 'incompatibleWith',
      left: { column: 'Role A', targetType: 'Resource' },
      right: { column: 'Role B', targetType: 'OrgEntity', targetEntityType: 'Application' },
      attributes: [{ column: 'Reason' }],
    });
  });

  it('attributesForApi carries multi only when it is true', () => {
    expect(T.attributesForApi([{ column: 'Skills', name: 'expertises', multi: true }, { column: 'Level', multi: false }, { column: ' ', multi: true }]))
      .toEqual([{ column: 'Skills', name: 'expertises', multi: true }, { column: 'Level' }]);
    expect(T.attributesForApi(undefined)).toEqual([]);
  });
});

describe('the activity dry run', () => {
  const keys = { actor: { total: 12, accepted: 9, proposed: 2, unmatched: 1 }, subject: { total: 4, accepted: 4, proposed: 0, unmatched: 0 } };

  it('blocks a report that read no activity, warns on skipped rows and unmatched values', () => {
    const blockers = [];
    const warnings = [];
    T.activityFindings({ activities: 0, skipped: 1, keys }, blockers, warnings);
    expect(blockers).toEqual(['No row could be read as an activity: check the actor, subject and date columns.']);
    expect(warnings).toEqual([
      '1 row is skipped: no date, actor or subject could be read.',
      '1 of 12 actor values match nothing yet; review them after the import.',
    ]);
  });

  it('says nothing for a clean report or a report that is not an activity one', () => {
    const blockers = [];
    const warnings = [];
    T.activityFindings({ activities: 1, skipped: 0, keys: { actor: keys.subject } }, blockers, warnings);
    T.activityFindings({ links: {} }, blockers, warnings);
    T.activityFindings(null, blockers, warnings);
    expect([blockers, warnings]).toEqual([[], []]);
    T.activityFindings({ activities: 5, skipped: 2, keys: { subject: { unmatched: 3 } } }, blockers, warnings);
    expect(warnings).toEqual(['2 rows are skipped: no date, actor or subject could be read.', '3 of 3 subject values match nothing yet; review them after the import.']);
  });

  it('keyCountLine reads the four counts, defaulting missing ones to 0', () => {
    expect(T.keyCountLine('actor', keys.actor)).toBe('12 actor values: 9 matched, 2 proposed, 1 without a match');
    expect(T.keyCountLine('subject', { total: 1, accepted: 1 })).toBe('1 subject value: 1 matched, 0 proposed, 0 without a match');
  });

  it('previewRows takes the first five parsed rows', () => {
    const sample = Array.from({ length: 6 }, (_, i) => ({ actor: `A${i}` }));
    expect(T.previewRows({ sample }).map(r => r.actor)).toEqual(['A0', 'A1', 'A2', 'A3', 'A4']);
    expect(T.previewRows({ sample: 'x' })).toEqual([]);
    expect(T.previewRows(null)).toEqual([]);
  });

  it('periodText reads a month as a range and a day as a date', () => {
    expect(T.periodText({ occurredOn: '2026-03-01', periodEnd: '2026-03-31' })).toBe('2026-03-01 – 2026-03-31');
    expect(T.periodText({ occurredOn: '2026-03-04', periodEnd: null })).toBe('2026-03-04');
    expect(T.periodText({})).toBe('');
  });
});

describe('the proposal template block', () => {
  it('keeps a known kind only', () => {
    const t = { kind: 'activity', confidence: 88, reason: 'A date, a number and two name columns.', alternatives: ['collection'] };
    expect(T.proposalTemplate({ template: t })).toBe(t);
    expect(T.proposalTemplate({ template: { kind: 'other' } })).toBeNull();
    expect(T.proposalTemplate({})).toBeNull();
  });

  it('proposedKind prefers the recipe template, then the block, then collection', () => {
    expect(T.proposedKind({ recipe: { template: 'relation' }, template: { kind: 'activity' } })).toBe('relation');
    expect(T.proposedKind({ recipe: {}, template: { kind: 'enrichment' } })).toBe('enrichment');
    expect(T.proposedKind({ recipe: { template: 'x' }, template: { kind: 'x' } })).toBe('collection');
    expect(T.proposedKind(null)).toBe('collection');
  });
});
