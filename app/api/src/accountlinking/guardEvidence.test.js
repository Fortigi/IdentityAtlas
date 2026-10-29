// Unit tests for guardEvidence.js — what the name-uniqueness guard weighs
// beside a name (#1455).
//
// The whole value of this module is the word "exactly": each piece of evidence
// fires only where it singles out ONE of the people the name left to choose
// between (R2). Read as "the first claimant that matches", every one of these
// tests still passes on the single-claimant cases and the module hands every
// ambiguous ERP account to whoever happened to be indexed first — which is the
// outcome the issue was filed to avoid. So every case below is a pair: one
// claimant matching, and two.

import { describe, it, expect } from 'vitest';
import {
  EVIDENCE_TYPE, guardEvidence, evidenceSignalNames, corroborationCeiling, weighEvidence,
} from './guardEvidence.js';
import { DEFAULT_RULES } from './defaultRules.js';

const ALL = guardEvidence(DEFAULT_RULES);
const only = (name) => guardEvidence({ signals: DEFAULT_RULES.signals.filter(s => s.name === name) });

const idy = (id, extra = {}) => ({ id, displayName: id, ...extra });

describe('guardEvidence — reading the dictionary', () => {
  it('ships nameUnique, department and manager, in ladder order', () => {
    // The order is the order they are weighed in, so it is asserted rather than
    // sorted: the strongest-stated piece is the one that picks.
    expect(ALL.map(e => [e.name, e.weight])).toEqual([
      ['nameUnique', 10], ['department', 10], ['manager', 15],
    ]);
  });

  it('drops a piece the tenant switched off at weight 0', () => {
    const rules = {
      signals: DEFAULT_RULES.signals.map(s => (s.name === 'manager' ? { ...s, weight: 0 } : s)),
    };
    expect(guardEvidence(rules).map(e => e.name)).toEqual(['nameUnique', 'department']);
  });

  it('ignores an evidence signal this build cannot test', () => {
    // A tenant may have invented one, or be running a dictionary from a later
    // build. Inert, not an error — and not silently treated as a match either.
    const rules = { signals: [{ name: 'astrology', type: EVIDENCE_TYPE, weight: 90 }] };
    expect(guardEvidence(rules)).toEqual([]);
    // It is still a *known signal name*, so a link resting on it stays name-only.
    expect(evidenceSignalNames(rules).has('astrology')).toBe(true);
  });

  it('names every evidence signal the dictionary defines, on or off', () => {
    expect([...evidenceSignalNames(DEFAULT_RULES)]).toEqual(['nameUnique', 'department', 'manager']);
    expect(evidenceSignalNames({})).toEqual(new Set());
  });

  it('sums the ceiling from the switched-on pieces only', () => {
    // What decides whether a below-threshold name-only match is weighed at all,
    // so an over-count would hold matches a raised slider is meant to stop.
    expect(corroborationCeiling(ALL)).toBe(35);
    expect(corroborationCeiling(only('nameUnique'))).toBe(10);
    expect(corroborationCeiling([])).toBe(0);
  });
});

describe('weighEvidence — nameUnique', () => {
  it('corroborates the identity the name itself points at', () => {
    const sole = idy('a');
    expect(weighEvidence({}, [sole], sole, ALL)).toEqual({
      identity: sole, signals: ['nameUnique'], bonus: 10,
    });
  });

  it('adds nothing where the name points at nobody', () => {
    expect(weighEvidence({}, [idy('a'), idy('b')], null, ALL)).toEqual({
      identity: null, signals: [], bonus: 0,
    });
  });
});

describe('weighEvidence — department', () => {
  const dept = (v) => ({ department: v });

  it('picks the one claimant who shares the department', () => {
    const a = idy('a', dept('Finance'));
    const weighed = weighEvidence(dept('Finance'), [a, idy('b', dept('HR'))], null, ALL);
    expect(weighed).toEqual({ identity: a, signals: ['department'], bonus: 10 });
  });

  it('compares after lower-casing and trimming, and no further', () => {
    const a = idy('a', dept(' finance '));
    expect(weighEvidence(dept('Finance'), [a], null, ALL).signals).toEqual(['department']);
    // No fuzz: a department that merely starts the same is a different one.
    expect(weighEvidence(dept('Finance'), [idy('a', dept('Finance & Control'))], null, ALL))
      .toEqual({ identity: null, signals: [], bonus: 0 });
  });

  it('picks nobody where two claimants share it', () => {
    // The case the whole module exists for: a shared department says nothing
    // about which of two namesakes the account is.
    expect(weighEvidence(dept('Finance'), [idy('a', dept('Finance')), idy('b', dept('Finance'))], null, ALL))
      .toEqual({ identity: null, signals: [], bonus: 0 });
  });

  it('does not fire where the account carries no department', () => {
    // Otherwise every claimant whose department is also empty "matches" it.
    expect(weighEvidence(dept(''), [idy('a', dept(''))], null, ALL).signals).toEqual([]);
    expect(weighEvidence({}, [idy('a', dept(null))], null, ALL).signals).toEqual([]);
  });
});

describe('weighEvidence — manager', () => {
  const mgr = (v) => ({ managerIdentityId: v });

  it('picks the one claimant with the same manager', () => {
    const a = idy('a', mgr('m1'));
    expect(weighEvidence(mgr('m1'), [a, idy('b', mgr('m2'))], null, ALL))
      .toEqual({ identity: a, signals: ['manager'], bonus: 15 });
  });

  it('picks nobody where two claimants share the manager', () => {
    expect(weighEvidence(mgr('m1'), [idy('a', mgr('m1')), idy('b', mgr('m1'))], null, ALL))
      .toEqual({ identity: null, signals: [], bonus: 0 });
  });

  it('does not fire where the account’s manager is not resolved yet', () => {
    // The bootstrap gap, stated as behaviour: on the first run after an import
    // the manager's own account is usually still unlinked, so the column is
    // null. Firing here would match every claimant whose manager is also null.
    expect(weighEvidence(mgr(null), [idy('a', mgr(null))], null, ALL).signals).toEqual([]);
  });
});

describe('weighEvidence — several pieces at once', () => {
  it('sums every piece that agrees on the same person', () => {
    const sole = { id: 'a', department: 'Finance', managerIdentityId: 'm1' };
    expect(weighEvidence(
      { department: 'FINANCE', managerIdentityId: 'm1' }, [sole], sole, ALL,
    )).toEqual({ identity: sole, signals: ['nameUnique', 'department', 'manager'], bonus: 35 });
  });

  it('lets context pick where the name could not', () => {
    // The 107 links measured on the dataset where no department was recorded:
    // the name leaves two, the manager settles it, and the confidence says so.
    const a = { id: 'a', managerIdentityId: 'm1' };
    expect(weighEvidence({ managerIdentityId: 'm1' }, [a, { id: 'b', managerIdentityId: 'm2' }], null, ALL))
      .toEqual({ identity: a, signals: ['manager'], bonus: 15 });
  });

  it('does not count a piece that points at somebody else', () => {
    // Two pieces disagreeing about who the account is are not two votes. The
    // earlier-stated one stands; the other adds no confidence to it.
    const a = { id: 'a', department: 'Finance', managerIdentityId: 'm9' };
    const b = { id: 'b', department: 'HR', managerIdentityId: 'm1' };
    expect(weighEvidence({ department: 'Finance', managerIdentityId: 'm1' }, [a, b], null, ALL))
      .toEqual({ identity: a, signals: ['department'], bonus: 10 });
  });

  it('weighs nothing when the dictionary switched it all off', () => {
    const sole = idy('a', { department: 'Finance' });
    expect(weighEvidence({ department: 'Finance' }, [sole], sole, []))
      .toEqual({ identity: sole, signals: [], bonus: 0 });
  });
});
