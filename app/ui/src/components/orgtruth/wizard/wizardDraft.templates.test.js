// The wizard draft with the four templates: proposals (unforced and forced),
// choosing a kind, stored profiles, readiness dispatch, the exact recipe
// bodies sent per template, and the activity verdict.
import { describe, it, expect } from 'vitest';
import * as W from './wizardDraft';
import { patchPart } from './templateDraft';

const COLS = [{ name: 'Employee' }, { name: 'Customer' }, { name: 'Date' }, { name: 'Hours' }, { name: 'Skills' }];
const SOURCE = { id: 's9', displayName: 'Contoso hours', fileName: 'hours.xlsx', rowCount: 40, columns: COLS };
const TEMPLATE = { kind: 'activity', confidence: 91, reason: 'A date column, an hours column and two name columns.', alternatives: ['collection'] };
const ACTIVITY = {
  version: 1, template: 'activity',
  activity: {
    type: 'Hours', actor: { column: 'Employee', targetTypes: ['Principal', 'Identity'] },
    subject: { column: 'Customer', targetType: 'OrgEntity', targetEntityType: 'Client' },
    when: { dateColumn: 'Date' }, measure: { column: 'Hours', unit: 'h' }, attributes: [],
  },
};
const ENRICHMENT = {
  version: 1, template: 'enrichment', relations: [],
  entities: [{ type: 'Expertise', nameColumn: 'Employee', keyColumn: '', attributes: [
    { column: 'Skills', name: 'expertises', multi: true }, { column: 'Hours', name: '', multi: false },
  ] }],
  enrich: { targetType: 'Principal' },
};
const RULE = { entityType: 'Expertise', targetType: 'Principal', via: 'displayName', threshold: 50, signals: [{ attribute: 'displayName', targetField: 'email', type: 'exact', weight: 90 }] };
const sourced = () => W.setSource(W.emptyDraft(), SOURCE);

describe('applyProposal with a template', () => {
  it('an unforced proposal takes the proposed kind and keeps its template block', () => {
    const d = W.applyProposal(sourced(), { recipe: ACTIVITY, linkRules: [], origin: 'data', notes: [], template: TEMPLATE });
    expect(d.recipe.template).toBe('activity');
    expect(d.recipe.activity.subject).toEqual(ACTIVITY.activity.subject);
    expect(d.templateProposal).toBe(TEMPLATE);
    expect(d.templateChosen).toBe(false);
  });

  it('a recipe without a template is a collection, with no template key', () => {
    const d = W.applyProposal(sourced(), { recipe: { entities: [{ type: 'Project', nameColumn: 'Customer' }], relations: [] } });
    expect(d.recipe).toEqual({ version: 1, entities: [{ type: 'Project', nameColumn: 'Customer' }], relations: [] });
    expect(d.templateProposal).toBeNull();
  });

  it('a forced proposal takes the forced kind, keeps the first proposal’s block and marks the choice', () => {
    const first = W.applyProposal(sourced(), { recipe: ACTIVITY, template: TEMPLATE });
    const forced = W.applyProposal(first, {
      recipe: { template: 'relation', relation: { type: 'Pair' } }, linkRules: [{ entityType: 'X', signals: [] }],
      template: { kind: 'relation', reason: 'chosen' },
    }, 'relation');
    expect(forced.recipe.template).toBe('relation');
    expect(forced.recipe.relation.type).toBe('Pair');
    expect(forced.templateProposal).toBe(TEMPLATE);
    expect(forced.templateChosen).toBe(true);
    // the server answered another shape: the analyst's kind still wins
    expect(W.applyProposal(first, { recipe: ACTIVITY }, 'enrichment').recipe.template).toBe('enrichment');
  });
});

describe('chooseTemplate / editTemplate', () => {
  it('chooses a kind: an empty recipe of that shape, no rules, no notes, no report', () => {
    const before = { ...W.applyProposal(sourced(), { recipe: ACTIVITY, notes: ['n'], template: TEMPLATE }), linkRules: [RULE], quality: { rows: 1 } };
    const d = W.chooseTemplate(before, 'enrichment');
    expect(d.recipe.template).toBe('enrichment');
    expect(d.recipe.entities).toHaveLength(1);
    expect(d.linkRules).toEqual([]);
    expect(d.notes).toEqual([]);
    expect(d.quality).toBeNull();
    expect(d.templateChosen).toBe(true);
    expect(d.templateProposal).toBe(TEMPLATE);
    expect(W.chooseTemplate(before, 'collection').recipe).toEqual({ version: 1, entities: [], relations: [] });
  });

  it('editTemplate applies the edit and drops a report measured on the old recipe', () => {
    const d = W.editTemplate({ ...sourced(), recipe: ACTIVITY, quality: { rows: 3 } }, r => patchPart(r, 'activity', 'measure', { unit: 'days' }));
    expect(d.recipe.activity.measure).toEqual({ column: 'Hours', unit: 'days' });
    expect(d.quality).toBeNull();
  });
});

describe('stored profiles', () => {
  it('a collection recipe is used as stored', () => {
    const recipe = { version: 1, entities: [], relations: [] };
    expect(W.profileRecipe({ recipe })).toBe(recipe);
    expect(W.profileRecipe({ recipe, template: 'collection' })).toBe(recipe);
  });

  it('takes the template from the profile when the recipe does not carry it', () => {
    const { template: _ignored, ...bare } = ACTIVITY;
    const d = W.selectProfile(W.emptyDraft(), { id: 3, name: 'Hours', version: 2, template: 'activity', recipe: bare, linkRules: [] });
    expect(d.recipe.template).toBe('activity');
    expect(d.recipe.activity.when).toEqual({ dateColumn: 'Date' });
    // unchanged: the repeat reuses the profile rather than saving a version
    expect(W.profileAction(d)).toBe('reuse');
    expect(W.profileAction(W.editTemplate(d, r => patchPart(r, 'activity', 'measure', { unit: 'days' })))).toBe('version');
  });
});

describe('readiness per template', () => {
  it('recipeProblems dispatches on the template', () => {
    expect(W.recipeProblems({ recipe: ACTIVITY })).toEqual([]);
    expect(W.recipeProblems({ recipe: { ...ACTIVITY, activity: { ...ACTIVITY.activity, type: '' } } })).toEqual(['Name the activity, e.g. Hours.']);
    expect(W.recipeProblems({ recipe: ENRICHMENT })).toEqual([]);
    expect(W.recipeProblems({ recipe: W.chooseTemplate(sourced(), 'relation').recipe })[0]).toBe('Name the relation, e.g. Incompatibility.');
    expect(W.recipeProblems({ recipe: { version: 1, entities: [], relations: [] } })).toEqual(['Add at least one entity.']);
  });

  it('staleColumns sees the activity columns too', () => {
    const d = { ...W.setSource(W.emptyDraft(), { ...SOURCE, columns: COLS.filter(c => c.name !== 'Date') }), recipe: ACTIVITY };
    expect(W.staleColumns(d)).toEqual(['Date']);
  });
});

describe('what the API receives per template', () => {
  it('collection: no template key, exactly as before', () => {
    const recipe = { version: 1, entities: [{ type: 'Project', nameColumn: 'Customer', attributes: [{ column: 'Hours', name: 'h' }] }], relations: [] };
    expect(W.recipeForApi(recipe)).toEqual({ version: 1, entities: [{ type: 'Project', nameColumn: 'Customer', attributes: [{ column: 'Hours', name: 'h' }] }], relations: [] });
  });

  it('enrichment: the one entity, multi on the multi-valued attribute, the target', () => {
    expect(W.recipeForApi(ENRICHMENT)).toEqual({
      version: 1, template: 'enrichment',
      entities: [{ type: 'Expertise', nameColumn: 'Employee', attributes: [{ column: 'Skills', name: 'expertises', multi: true }, { column: 'Hours' }] }],
      relations: [], enrich: { targetType: 'Principal' },
    });
  });

  it('activity and relation: only their section', () => {
    expect(W.recipeForApi(ACTIVITY)).toEqual({
      version: 1, template: 'activity',
      activity: {
        type: 'Hours', actor: { column: 'Employee', targetTypes: ['Principal', 'Identity'] },
        subject: { column: 'Customer', targetType: 'OrgEntity', targetEntityType: 'Client' },
        when: { dateColumn: 'Date' }, measure: { column: 'Hours', unit: 'h' }, attributes: [],
      },
    });
    const rel = W.chooseTemplate(sourced(), 'relation').recipe;
    expect(Object.keys(W.recipeForApi(rel))).toEqual(['version', 'template', 'relation']);
  });

  it('activity and relation send no link rules; enrichment sends its rules', () => {
    const activity = { ...sourced(), recipe: ACTIVITY, linkRules: [RULE], profileName: 'Hours' };
    expect(W.dryRunBody(activity)).toEqual({ sourceId: 's9', recipe: W.recipeForApi(ACTIVITY), linkRules: [], mode: 'full' });
    expect(W.profileBody(activity).linkRules).toEqual([]);
    const relation = { ...W.chooseTemplate(sourced(), 'relation'), linkRules: [RULE] };
    expect(W.dryRunBody(relation).linkRules).toEqual([]);
    const enrichment = { ...sourced(), recipe: ENRICHMENT, linkRules: [RULE] };
    expect(W.dryRunBody(enrichment).linkRules).toEqual([RULE]);
    expect(W.profileBody(enrichment).linkRules).toEqual([RULE]);
  });

  it('proposeBody forces a kind only when asked', () => {
    expect(W.proposeBody(sourced(), 'activity')).toEqual({ fileName: 'hours.xlsx', columns: COLS, rowCount: 40, sourceId: 's9', template: 'activity' });
    expect(W.proposeBody(sourced(), null)).not.toHaveProperty('template');
    expect(W.proposeBody(sourced())).not.toHaveProperty('template');
  });
});

describe('qualityVerdict on an activity report', () => {
  it('blocks when no row became an activity and warns on unmatched values', () => {
    const v = W.qualityVerdict({ rows: 40, activities: 0, skipped: 40, keys: { actor: { total: 3, unmatched: 0 }, subject: { total: 2, unmatched: 2 } } }, 50);
    expect(v.canStart).toBe(false);
    expect(v.blockers).toEqual(['No row could be read as an activity: check the actor, subject and date columns.']);
    expect(v.warnings).toEqual(['40 rows are skipped: no date, actor or subject could be read.', '2 of 2 subject values match nothing yet; review them after the import.']);
  });

  it('lets a clean activity report start', () => {
    expect(W.qualityVerdict({ rows: 40, activities: 40, skipped: 0, keys: { actor: { total: 3, unmatched: 0 } } }, 50))
      .toEqual({ canStart: true, warnings: [], blockers: [] });
  });
});
