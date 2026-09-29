// Unit tests for the lookup-source registry.
//
// The registry is the seam: a source is a file plus one line in
// sources/index.js, and nothing downstream may know a source by name. These
// tests pin the two halves of that — what a source must declare to be
// registered at all, and that registering one is enough to make it resolvable.

import { describe, it, expect } from 'vitest';
import { getLookup, listLookups, registerLookup } from './registry.js';
import { BUILT_IN_LOOKUPS } from './sources/index.js';

const source = (over = {}) => ({
  name: 'test-source', displayName: 'Test Source', search: async () => [], ...over,
});

describe('lookup registry', () => {
  it('seeds itself from the built-in sources, each declaring the required fields', () => {
    expect(BUILT_IN_LOOKUPS.length).toBeGreaterThan(0);
    for (const built of BUILT_IN_LOOKUPS) {
      expect(getLookup(built.name), built.name).toBe(built);
      expect(typeof built.displayName).toBe('string');
      expect(typeof built.search).toBe('function');
    }
  });

  it.each([
    ['name', { name: undefined }],
    ['displayName', { displayName: undefined }],
    ['search', { search: undefined }],
  ])('refuses a source with no %s, naming what is missing', (field, missing) => {
    expect(() => registerLookup(source(missing))).toThrow(new RegExp(field));
  });

  it('refuses a non-object rather than registering undefined', () => {
    expect(() => registerLookup(null)).toThrow(/Invalid lookup source/);
  });

  it('registers a source and takes it away again', () => {
    expect(getLookup('test-source')).toBeNull();
    const unregister = registerLookup(source());
    expect(getLookup('test-source')).toMatchObject({ displayName: 'Test Source' });
    unregister();
    expect(getLookup('test-source')).toBeNull();
  });

  it('lists sources by display name, not by registration order', () => {
    const a = registerLookup(source({ name: 'zzz', displayName: 'Aardvark' }));
    const b = registerLookup(source({ name: 'aaa', displayName: 'Zebra' }));
    try {
      const names = listLookups().map(s => s.displayName);
      expect(names.indexOf('Aardvark')).toBeLessThan(names.indexOf('Zebra'));
    } finally { a(); b(); }
  });

  it('replaces a source registered twice under one name', () => {
    const first = registerLookup(source({ displayName: 'First' }));
    const second = registerLookup(source({ displayName: 'Second' }));
    try {
      expect(getLookup('test-source').displayName).toBe('Second');
    } finally { second(); first(); }
    expect(getLookup('test-source')).toBeNull();
  });
});
