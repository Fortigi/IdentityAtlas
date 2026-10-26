// Unit tests for the effective-dictionary merge (#1469).
//
// What this file pins is an upgrade promise: a tenant who edits the Account
// Linking settings keeps every value they set, *and* keeps receiving the signals
// later builds ship. Both halves are silent when broken — the saved values
// quietly reverting to the shipped ones, or a shipped signal quietly never
// firing — so every case below is chosen to tell the two apart rather than to
// execute the merge.
//
// The inputs are therefore never "a dictionary": they are a dictionary that
// *discriminates*. A saved list in shipped order could not catch an append, so
// the ordering case saves it reversed. A tenant weight equal to the shipped one
// could not catch the shipped definition winning, so the reweight case uses 99.

import { describe, it, expect } from 'vitest';
import { effectiveLinkingRules } from './rulesMerge.js';
import { DEFAULT_RULES } from './defaultRules.js';
import { PRE_LOGIN_NAME_FORM_RULES } from '../../test-utils/preShippedLinkingRules.js';

/** The signal called `name` in a dictionary, or undefined. */
const signal = (rules, name) => (rules.signals || []).find(s => s.name === name);
const names = (rules) => (rules.signals || []).map(s => s.name);

const SHIPPED_NAMES = DEFAULT_RULES.signals.map(s => s.name);

describe('effectiveLinkingRules — signals merged by name', () => {
  it('adds a shipped signal the saved dictionary predates, with its shipped definition', () => {
    // The reported defect: this is the dictionary a tenant stored before
    // loginNameForm shipped. The signal has to come back complete — its weight
    // AND its stripPrefixes, since a prefix list the merge invented would read
    // an `adm-` login as nobody's.
    const merged = effectiveLinkingRules(PRE_LOGIN_NAME_FORM_RULES);

    expect(names(PRE_LOGIN_NAME_FORM_RULES)).not.toContain('loginNameForm'); // the fixture is the pre-#1466 list
    expect(signal(merged, 'loginNameForm')).toEqual(signal(DEFAULT_RULES, 'loginNameForm'));
    expect(names(merged)).toEqual(SHIPPED_NAMES);
  });

  it("keeps the tenant's own definition of a signal they saved, verbatim", () => {
    // A real tenant edit: fullName reweighted well above the shipped 60, and
    // emailPrefix narrowed to one provisioning prefix. Neither value may be
    // reverted, and neither signal may appear twice.
    const saved = {
      signals: [
        { name: 'fullName', type: 'name', level: 'full', weight: 99 },
        { name: 'emailPrefix', type: 'prefix', field: 'email', weight: 80, stripPrefixes: ['adm-'] },
      ],
    };

    const merged = effectiveLinkingRules(saved);

    expect(signal(merged, 'fullName')).toEqual(saved.signals[0]);
    expect(signal(merged, 'emailPrefix').stripPrefixes).toEqual(['adm-']);
    expect(names(merged)).toEqual(SHIPPED_NAMES); // substituted in place, not appended
  });

  it('leaves a signal the tenant switched off at weight 0 switched off', () => {
    // Weight 0 is the off-switch the merge promises, and the only one: a tenant
    // who deleted loginNameForm gets it back (case above), so a tenant who
    // *disabled* it must not have the shipped weight 55 put back instead.
    const merged = effectiveLinkingRules({
      signals: [{ name: 'loginNameForm', type: 'loginName', field: 'email', weight: 0, stripPrefixes: ['adm-'] }],
    });

    expect(signal(merged, 'loginNameForm').weight).toBe(0);
  });

  it('orders the merged list by the shipped ladder, not by when a signal shipped', () => {
    // strongestNameRung breaks equal weights by position, so order is behaviour.
    // Saved reversed: an implementation that kept the saved order and appended
    // the missing signals would answer with the tenant's list back-to-front and
    // silently invert every tie.
    const saved = { signals: [...PRE_LOGIN_NAME_FORM_RULES.signals].reverse() };

    expect(names(effectiveLinkingRules(saved))).toEqual(SHIPPED_NAMES);
  });

  it("keeps a signal only the tenant has, after the shipped ladder", () => {
    const mine = { name: 'badgeNumber', type: 'exact', field: 'employeeId', weight: 70 };
    const saved = { signals: [mine, ...PRE_LOGIN_NAME_FORM_RULES.signals] };

    // Appended rather than left in front: the shipped ladder is the fixed
    // precedence, and a tenant's own signal must not jump ahead of it on a tie.
    expect(names(effectiveLinkingRules(saved))).toEqual([...SHIPPED_NAMES, 'badgeNumber']);
    expect(signal(effectiveLinkingRules(saved), 'badgeNumber')).toEqual(mine);
  });

  it('gives back the whole shipped ladder to a dictionary that lists no signals at all', () => {
    // Deleting a signal does not disable it, so deleting all of them doesn't
    // either — otherwise an administrator who cleared the array would have an
    // engine that silently links nothing. Both ways of saying nothing about
    // signals (an empty list, no key) answer the same.
    expect(names(effectiveLinkingRules({ signals: [], linkThreshold: 70 }))).toEqual(SHIPPED_NAMES);
    expect(names(effectiveLinkingRules({ linkThreshold: 70 }))).toEqual(SHIPPED_NAMES);
  });
});

describe('effectiveLinkingRules — the other keys', () => {
  it('lets a saved value replace the shipped one for every non-signal key', () => {
    // Shallow semantics, unchanged: these are single values or lists with no
    // per-entry off-switch, so the tenant's word is final. accountTypeRules
    // especially — re-adding a pattern they removed would reclassify their
    // accounts with no way to refuse it.
    const saved = {
      linkThreshold: 85,
      onlyLinkTypes: ['Secondary'],
      allowNameOnlyLinks: false,
      accountTypeRules: [{ accountType: 'Admin', priority: 1, patterns: ['^myadm-'] }],
    };

    const merged = effectiveLinkingRules(saved);

    expect(merged.linkThreshold).toBe(85);
    expect(merged.onlyLinkTypes).toEqual(['Secondary']);
    expect(merged.allowNameOnlyLinks).toBe(false);
    expect(merged.accountTypeRules).toEqual(saved.accountTypeRules);
  });

  it('keeps the shipped value for a key the tenant never saved', () => {
    const merged = effectiveLinkingRules({ linkThreshold: 85 });

    expect(merged.allowNameOnlyLinks).toBe(DEFAULT_RULES.allowNameOnlyLinks);
    expect(merged.onlyLinkTypes).toEqual(DEFAULT_RULES.onlyLinkTypes);
    expect(merged.accountTypeRules).toEqual(DEFAULT_RULES.accountTypeRules);
  });

  it('answers with the shipped dictionary when nothing is saved', () => {
    // An install that has never opened the settings, and a row whose rules
    // column is empty or not an object at all (a partially-migrated or
    // hand-edited row) — none of them may fail the read.
    for (const nothing of [null, undefined, '', 'not-a-dictionary', 0]) {
      expect(effectiveLinkingRules(nothing)).toEqual(DEFAULT_RULES);
    }
  });
});

describe('effectiveLinkingRules — safe to serve and to re-save', () => {
  it('is idempotent, so the editor can save back exactly what it was shown', () => {
    // GET /account-linking/config serves the merged dictionary and Save PUTs it
    // straight back. If the second merge differed, every visit to the settings
    // page would rewrite the tenant's stored rules into something else.
    const once = effectiveLinkingRules(PRE_LOGIN_NAME_FORM_RULES);

    expect(effectiveLinkingRules(once)).toEqual(once);
  });

  it('does not write through to the shipped defaults or to the saved rules', () => {
    // The shipped dictionary is a module-level object shared by every request,
    // and the saved one belongs to the row that was read. A merge that spliced
    // into either would leak one tenant's edit into the next run.
    const saved = { signals: [{ name: 'fullName', type: 'name', level: 'full', weight: 99 }] };
    const shippedBefore = JSON.parse(JSON.stringify(DEFAULT_RULES));

    const merged = effectiveLinkingRules(saved);
    merged.signals.push({ name: 'invented', weight: 1 });
    merged.linkThreshold = 1;

    expect(DEFAULT_RULES).toEqual(shippedBefore);
    expect(saved.signals).toHaveLength(1);
    expect(saved.linkThreshold).toBeUndefined();
  });
});
