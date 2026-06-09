import { describe, it, expect } from 'vitest';
import { VARIANT_META, TARGET_TYPE_META, variantMeta, targetTypeMeta, editedMeta } from './contextStyles';

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
