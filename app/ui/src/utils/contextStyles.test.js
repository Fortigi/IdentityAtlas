import { describe, it, expect } from 'vitest';
import { VARIANT_META, TARGET_TYPE_META, variantMeta, targetTypeMeta } from './contextStyles';

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
