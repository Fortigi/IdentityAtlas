import { describe, it, expect } from 'vitest';
import { diffContexts, contextChanged } from './diff.js';

const rec = (over = {}) => ({ id: 'c1', displayName: 'Acme', parentContextId: 'root', ownerUserId: null, targetType: 'Principal', extendedAttributes: { a: '1', b: '2' }, ...over });
const row = (over = {}) => ({ id: 'c1', displayName: 'Acme', parentContextId: 'root', ownerUserId: '', targetType: 'Principal', extendedAttributes: { b: '2', a: '1' }, ...over });

describe('contextChanged', () => {
  it('ignores attribute key order, a JSON string and empty-vs-null owner', () => {
    expect(contextChanged(rec(), row())).toBe(false);
    expect(contextChanged(rec(), row({ extendedAttributes: '{"a":"1","b":"2"}' }))).toBe(false);
    expect(contextChanged(rec({ extendedAttributes: null }), row({ extendedAttributes: {} }))).toBe(false);
  });

  it.each([
    ['the name', { displayName: 'Acme BV' }],
    ['the parent', { parentContextId: 'other' }],
    ['the owner', { ownerUserId: 'o@x.nl' }],
    ['the member kind', { targetType: 'Resource' }],
    ['an attribute value', { extendedAttributes: { a: '1', b: '3' } }],
    ['an attribute removed', { extendedAttributes: { a: '1' } }],
  ])('sees a change of %s', (_label, change) => {
    expect(contextChanged(rec(change), row())).toBe(true);
  });
});

describe('diffContexts', () => {
  it('counts created, updated and unchanged, and lists the stored contexts the file no longer has', () => {
    const records = [rec({ id: 'same' }), rec({ id: 'changed', displayName: 'New' }), rec({ id: 'new' })];
    const existing = [row({ id: 'same' }), row({ id: 'changed' }), row({ id: 'gone' })];
    expect(diffContexts(records, existing)).toEqual({ created: 1, updated: 1, unchanged: 1, missingIds: ['gone'] });
  });

  it('a first upload creates everything', () => {
    expect(diffContexts([rec({ id: 'a' }), rec({ id: 'b' })], [])).toEqual({ created: 2, updated: 0, unchanged: 0, missingIds: [] });
  });
});
