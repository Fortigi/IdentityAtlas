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

describe('AdditiveAllow.resolve - decisive pick, with the winner listed FIRST', () => {
  // The tests above all list the expected winner LAST, so "always keep the ace we just
  // looked at" produces the same answer as "pick the best one" -- the reduce could ignore
  // its accumulator entirely and still pass. These put the winner first, which is the only
  // ordering that tells the two apart. The decisive ACE drives the badge, so getting it
  // wrong shows a user Direct access that is really inherited through a group.
  it('keeps the direct allow even when weaker ones come after it', () => {
    const direct = allow({ explicit: true, viaGroupId: null });
    const viaGroup = allow({ explicit: true, viaGroupId: 'g1', distance: 1 });
    const inherited = allow({ explicit: false, distance: 2 });
    const r = AdditiveAllow.resolve([direct, viaGroup, inherited]);
    expect(r.decisiveAce).toBe(direct);
    expect(badgeForAce(r.decisiveAce)).toBe('Direct');
  });

  it('keeps the nearest inherited allow even when a farther one comes after it', () => {
    const near = allow({ explicit: false, distance: 2 });
    const far = allow({ explicit: false, distance: 9 });
    const r = AdditiveAllow.resolve([near, far]);
    expect(r.decisiveAce).toBe(near);
  });

  it('prefers an explicit group grant over a CLOSER inherited one', () => {
    // Rank beats distance: explicit-via-group (rank 1) wins over inherited (rank 2) even
    // from further away. Both badge as Indirect, which is why the existing badge-only
    // assertions cannot see this distinction at all -- but the decisive ACE is what the
    // UI reports as the reason for the access.
    const viaGroup = allow({ explicit: true, viaGroupId: 'g1', distance: 7 });
    const inherited = allow({ explicit: false, distance: 0 });
    const r = AdditiveAllow.resolve([viaGroup, inherited]);
    expect(r.decisiveAce).toBe(viaGroup);
    const reversed = AdditiveAllow.resolve([inherited, viaGroup]);
    expect(reversed.decisiveAce).toBe(viaGroup);
  });

  it('keeps the first of two equally-ranked, equally-distant allows', () => {
    // A stable tie-break. Read as <=, the later ACE displaces an equally good earlier one,
    // so the reported reason for someone's access changes with input order alone.
    const first = allow({ explicit: false, distance: 3, aceId: 'a' });
    const second = allow({ explicit: false, distance: 3, aceId: 'b' });
    expect(AdditiveAllow.resolve([first, second]).decisiveAce.aceId).toBe('a');
  });
});

describe('AdditiveAllow.resolve / badgeForAce - absent input', () => {
  it('treats a missing ACE as Indirect rather than throwing', () => {
    // badgeForAce(decisiveAce) is called on results that can carry a null decisive ACE,
    // so the guard is load-bearing: without it the caller dies on a null dereference.
    expect(badgeForAce(null)).toBe('Indirect');
    expect(badgeForAce(undefined)).toBe('Indirect');
  });

  it('treats a missing ACE list as no access', () => {
    // The `aces || []` fallback had no coverage at all.
    expect(AdditiveAllow.resolve(null).effective).toBe('none');
    expect(AdditiveAllow.resolve(undefined).effective).toBe('none');
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
