// Unit tests for ContextPicker's matchesTargetTypes helper — the target-type
// filter applied to root contexts. Behaviour-preserving extraction of the
// inline filter predicate that previously lived in filteredTrees.

import { describe, it, expect } from 'vitest';
import { matchesTargetTypes } from './ContextPicker.helpers.js';

const identityCtx = { id: 'a', targetType: 'Identity' };
const resourceCtx = { id: 'b', targetType: 'Resource' };
const principalCtx = { id: 'c', targetType: 'Principal' };
const roots = [identityCtx, resourceCtx, principalCtx];

const filter = (opts) => roots.filter(r => matchesTargetTypes(r, opts));

describe('matchesTargetTypes', () => {
  it('keeps only contexts whose targetType is in the targetTypes array', () => {
    const kept = filter({ targetTypes: ['Identity', 'Principal'] });
    expect(kept.map(r => r.id)).toEqual(['a', 'c']);
  });

  it('single targetType still filters correctly', () => {
    const kept = filter({ targetType: 'Resource' });
    expect(kept.map(r => r.id)).toEqual(['b']);
  });

  it('targetTypes takes precedence over a conflicting single targetType', () => {
    // targetType would keep only Resource, but targetTypes wins → Identity.
    const kept = filter({ targetTypes: ['Identity'], targetType: 'Resource' });
    expect(kept.map(r => r.id)).toEqual(['a']);
  });

  it('an empty targetTypes array falls back to the single targetType', () => {
    const kept = filter({ targetTypes: [], targetType: 'Principal' });
    expect(kept.map(r => r.id)).toEqual(['c']);
  });

  it('no filters → everything passes through', () => {
    expect(filter({}).map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(filter({ targetTypes: null, targetType: null }).map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('undefined options → no filtering', () => {
    expect(matchesTargetTypes(identityCtx)).toBe(true);
  });

  it('returns false for a non-matching single targetType', () => {
    expect(matchesTargetTypes(resourceCtx, { targetType: 'Identity' })).toBe(false);
  });
});
