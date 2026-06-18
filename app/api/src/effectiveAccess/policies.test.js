import { describe, it, expect } from 'vitest';
import { AdditiveAllow, badgeForAce, getPolicy, DEFAULT_POLICY } from './policies.js';

const allow = (over = {}) => ({ effect: 'allow', distance: 0, explicit: true, viaGroupId: null, ...over });
const deny = (over = {}) => ({ effect: 'deny', distance: 0, explicit: true, viaGroupId: null, ...over });

describe('badgeForAce', () => {
  it('Direct when explicit and not via a group', () => {
    expect(badgeForAce(allow())).toBe('Direct');
  });
  it('Indirect when reached via a group', () => {
    expect(badgeForAce(allow({ viaGroupId: 'g1' }))).toBe('Indirect');
  });
  it('Indirect when inherited (not explicit)', () => {
    expect(badgeForAce(allow({ explicit: false, distance: 2 }))).toBe('Indirect');
  });
  it('Eligible for an eligible ACE regardless of reachability', () => {
    expect(badgeForAce({ effect: 'eligible', explicit: true, viaGroupId: null })).toBe('Eligible');
  });
});

describe('AdditiveAllow.resolve', () => {
  it('returns none for an empty ACE set', () => {
    expect(AdditiveAllow.resolve([])).toEqual({ effective: 'none', decisiveAce: null, contributing: [] });
  });

  it('returns allow when any allow is present', () => {
    const r = AdditiveAllow.resolve([allow({ explicit: false, distance: 3 })]);
    expect(r.effective).toBe('allow');
  });

  it('ignores deny entirely (monotonic)', () => {
    const r = AdditiveAllow.resolve([deny(), deny({ distance: 1 })]);
    expect(r.effective).toBe('none');
    expect(r.contributing).toHaveLength(0);
  });

  it('a single deny does not suppress an allow', () => {
    const r = AdditiveAllow.resolve([deny(), allow({ explicit: false })]);
    expect(r.effective).toBe('allow');
  });

  it('picks the most-Direct allow as decisive (drives the badge)', () => {
    const inherited = allow({ explicit: false, distance: 4 });
    const viaGroup = allow({ explicit: true, viaGroupId: 'g1' });
    const direct = allow({ explicit: true, viaGroupId: null });
    const r = AdditiveAllow.resolve([inherited, viaGroup, direct]);
    expect(badgeForAce(r.decisiveAce)).toBe('Direct');
  });

  it('prefers the closest inherited allow when none are direct', () => {
    const far = allow({ explicit: false, distance: 9 });
    const near = allow({ explicit: false, distance: 2 });
    const r = AdditiveAllow.resolve([far, near]);
    expect(r.decisiveAce.distance).toBe(2);
  });

  it('eligible/notset alone do not grant', () => {
    const r = AdditiveAllow.resolve([{ effect: 'eligible' }, { effect: 'notset' }]);
    expect(r.effective).toBe('none');
  });
});

describe('getPolicy', () => {
  it('resolves the default policy', () => {
    expect(getPolicy(DEFAULT_POLICY).name).toBe('AdditiveAllow');
  });
  it('throws on an unknown policy', () => {
    expect(() => getPolicy('NopeOverrides')).toThrow();
  });
});
