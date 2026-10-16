import { describe, it, expect } from 'vitest';
import { validateLinkRules, normalizeRecipe } from './contracts.js';
import {
  referenceRule, relationLinkRules, activityKeyRules, roleTargets, KEY_ENTITY_TYPE, REFERENCE_THRESHOLD,
} from './referenceRules.js';

const sig = (r) => r.signals.map(s => `${s.attribute}:${s.targetField}:${s.type}:${s.weight}`);

describe('referenceRule', () => {
  it('people are found by address, exact name, graded name and fuzzy name', () => {
    for (const targetType of ['Principal', 'Identity']) {
      const r = referenceRule({ entityType: 'T', via: 'who', targetType });
      expect(sig(r)).toEqual(['who:email:exact:90', 'who:displayName:exact:80', 'who:displayName:name:60', 'who:displayName:fuzzy:70']);
      expect(r).toMatchObject({ entityType: 'T', targetType, via: 'who', threshold: REFERENCE_THRESHOLD });
    }
    expect(REFERENCE_THRESHOLD).toBe(60);
  });

  it('resources by exact name or external id, then fuzzy; another list fuzzy only, with its type', () => {
    expect(sig(referenceRule({ entityType: 'T', via: 'v', targetType: 'Resource' }))).toEqual(['v:displayName:exact:90', 'v:externalId:exact:90', 'v:displayName:fuzzy:60']);
    const org = referenceRule({ entityType: 'T', via: 'v', targetType: 'OrgEntity', targetEntityType: 'Customer' });
    expect(sig(org)).toEqual(['v:displayName:fuzzy:100']);
    expect(org.targetEntityType).toBe('Customer');
    expect('targetEntityType' in referenceRule({ entityType: 'T', via: 'v', targetType: 'Resource', targetEntityType: 'Customer' })).toBe(false);
  });

  it('every signal has its own name, so no index of a rule overwrites another', () => {
    const names = referenceRule({ entityType: 'T', via: 'v', targetType: 'Principal' }).signals.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(['email exact', 'displayName exact', 'displayName name', 'displayName fuzzy']);
  });
});

describe('relationLinkRules', () => {
  const recipe = normalizeRecipe({
    version: 1, template: 'relation',
    relation: { type: 'SoD', predicate: 'incompatibleWith', left: { column: 'A', targetType: 'Resource' }, right: { column: 'B', targetType: 'OrgEntity', targetEntityType: 'App' } },
  });

  it('one normalised rule per end, via left and right, and they validate against the relation', () => {
    const rules = relationLinkRules(recipe);
    expect(rules.map(r => [r.name, r.via, r.targetType, r.targetEntityType])).toEqual([
      ['SoD → Resource via left', 'left', 'Resource', undefined],
      ['SoD → App via right', 'right', 'OrgEntity', 'App'],
    ]);
    expect(validateLinkRules(rules, recipe)).toEqual({ ok: true, errors: [] });
  });
});

describe('activity key rules', () => {
  const recipe = normalizeRecipe({
    version: 1, template: 'activity',
    activity: {
      type: 'Hours', actor: { column: 'P', targetTypes: ['Identity', 'Principal'] },
      subject: { column: 'C', targetType: 'OrgEntity', targetEntityType: 'Customer' }, when: { dateColumn: 'D' },
    },
  });

  it('the actor resolves to its target types in the recipe\'s order; the subject to its one target', () => {
    expect(roleTargets(recipe, 'actor')).toEqual([{ targetType: 'Identity' }, { targetType: 'Principal' }]);
    expect(roleTargets(recipe, 'subject')).toEqual([{ targetType: 'OrgEntity', targetEntityType: 'Customer' }]);
    const actor = activityKeyRules(recipe, 'actor');
    expect(actor.map(r => r.targetType)).toEqual(['Identity', 'Principal']);
    expect(actor.every(r => r.entityType === KEY_ENTITY_TYPE && r.via === 'displayName')).toBe(true);
    const [subject] = activityKeyRules(recipe, 'subject');
    expect(subject).toMatchObject({ targetType: 'OrgEntity', targetEntityType: 'Customer', threshold: 60 });
  });

  it('the key entity type can never be the type of a list', () => {
    expect(KEY_ENTITY_TYPE.startsWith('\u0000')).toBe(true);
  });
});
