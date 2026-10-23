import { describe, it, expect } from 'vitest';
import {
  VARIANT_META, TARGET_TYPE_META, CATEGORY_META, CATEGORY_ORDER,
  variantMeta, targetTypeMeta, categoryMeta, editedMeta, memberKindLabel, MEMBER_KINDS,
} from './contextStyles';

describe('memberKindLabel', () => {
  it('names each kind of member in the template screens\' words', () => {
    expect(MEMBER_KINDS.map(memberKindLabel)).toEqual(['People', 'Accounts', 'Resources']);
    expect(memberKindLabel('System')).toBe('Systems');
  });

  it('falls back to "Members" for an unknown or missing kind', () => {
    expect(memberKindLabel('Gadget')).toBe('Members');
    expect(memberKindLabel(undefined)).toBe('Members');
  });
});

// These metas are applied raw (no per-call dark: overrides) by every Contexts
// component, so a colour class without a dark: variant breaks the whole tab in
// dark mode. Guard against that regressing.

describe('contextStyles dark-mode coverage', () => {
  it('every variant textClass has a dark: variant', () => {
    for (const [key, meta] of Object.entries(VARIANT_META)) {
      expect(meta.textClass, `VARIANT_META.${key}.textClass`).toMatch(/dark:/);
    }
  });

  it('every target-type badgeClass has a dark: variant', () => {
    for (const [key, meta] of Object.entries(TARGET_TYPE_META)) {
      expect(meta.badgeClass, `TARGET_TYPE_META.${key}.badgeClass`).toMatch(/dark:/);
    }
  });

  it('the unknown/fallback metas also carry dark: variants', () => {
    expect(variantMeta('nope').textClass).toMatch(/dark:/);
    expect(targetTypeMeta('nope').badgeClass).toMatch(/dark:/);
  });

  it('Principal is visually distinct from the Unknown fallback', () => {
    expect(TARGET_TYPE_META.Principal.badgeClass).not.toEqual(targetTypeMeta('nope').badgeClass);
  });

  it('every template badgeClass has a dark: variant, and so does Other', () => {
    for (const [key, meta] of Object.entries(CATEGORY_META)) {
      expect(meta.badgeClass, `CATEGORY_META.${key}.badgeClass`).toMatch(/dark:/);
    }
    expect(categoryMeta(null).badgeClass).toMatch(/dark:/);
  });
});

describe('categoryMeta — the four templates plus Other', () => {
  it('labels the four templates and describes each one', () => {
    expect(categoryMeta('OrganizationalUnit').label).toBe('Organisation');
    expect(categoryMeta('LogicalApplication').label).toBe('Application');
    expect(categoryMeta('Tag').label).toBe('Tag');
    expect(categoryMeta('Segment').label).toBe('Segment');
    for (const meta of Object.values(CATEGORY_META)) expect(meta.description).toMatch(/\S/);
  });

  it('falls back to Other for null, undefined and an unknown value', () => {
    expect(categoryMeta(null).label).toBe('Other');
    expect(categoryMeta(undefined).groupLabel).toBe('Other');
    expect(categoryMeta('Nope').label).toBe('Other');
  });

  it('uses hues no variant or target-type meta already uses', () => {
    const taken = [
      ...Object.values(VARIANT_META).map(m => m.dotClass),
      ...Object.values(TARGET_TYPE_META).map(m => m.badgeClass),
    ].join(' ');
    for (const [key, meta] of Object.entries(CATEGORY_META)) {
      const hue = meta.badgeClass.match(/^bg-([a-z]+)-/)[1];
      expect(taken, `${key} reuses ${hue}`).not.toMatch(new RegExp(`\\b(bg|text)-${hue}-`));
    }
  });

  it('orders the templates with Other last', () => {
    expect(CATEGORY_ORDER).toEqual(['OrganizationalUnit', 'LogicalApplication', 'Tag', 'Segment', 'Other']);
    expect(CATEGORY_ORDER.slice(0, 4).every(k => CATEGORY_META[k])).toBe(true);
  });
});

describe('editedMeta — analyst-curation marker', () => {
  it('marks a renamed generated node', () => {
    const m = editedMeta({ variant: 'generated', userRenamed: true });
    expect(m).not.toBeNull();
    expect(m.label).toBe('Edited');
    expect(m.title).toMatch(/renamed/);
    expect(m.ringClass).toMatch(/dark:/);
    expect(m.badgeClass).toMatch(/dark:/);
  });

  it('marks a re-parented generated node and names the change "moved"', () => {
    const m = editedMeta({ variant: 'generated', userReparented: true });
    expect(m.title).toMatch(/moved/);
  });

  it('reports both edits when a node was renamed AND moved', () => {
    const m = editedMeta({ variant: 'generated', userRenamed: true, userReparented: true });
    expect(m.title).toMatch(/renamed \+ moved/);
  });

  it('returns null for an untouched generated node', () => {
    expect(editedMeta({ variant: 'generated' })).toBeNull();
  });

  it('returns null for manual and synced nodes (they are not generated)', () => {
    expect(editedMeta({ variant: 'manual', userRenamed: true })).toBeNull();
    expect(editedMeta({ variant: 'synced', userReparented: true })).toBeNull();
  });

  it('handles a null/undefined node', () => {
    expect(editedMeta(null)).toBeNull();
    expect(editedMeta(undefined)).toBeNull();
  });
});
