// The attribute display-name resolver — issue #872.
//
// Inputs are chosen to DISCRIMINATE, not just to execute: near-miss key shapes
// (31 and 33 hex chars, non-hex, no trailing name) sit next to the real one, and
// the collision cases assert the disambiguated labels AND that the storage keys
// come back untouched — a resolver that quietly re-keyed the data would pass a
// "label is clean" assertion on its own.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import {
  EXTENSION_KEY_RE,
  extensionAppId,
  stripExtensionPrefix,
  buildAttributeLabels,
  getAttributeLabels,
  withAttributeLabels,
  clearAttributeLabelCache,
  LABEL_TARGET_TABLES,
} from './attributeLabels.js';

const APP_A = '8ce8d3db3b314def88d829e15494e83f';
const APP_B = '1f2e3d4c5b6a79880011223344556677';

describe('stripExtensionPrefix — the rule (D1/D2)', () => {
  it('returns the attribute name after extension_<appId>_ verbatim (AC1)', () => {
    expect(stripExtensionPrefix(`extension_${APP_A}_sAMAccountName`)).toBe('sAMAccountName');
  });

  it('keeps camelCase intact rather than word-splitting it', () => {
    // The whole point of D2: friendlyLabel would render this "Sf Cost Center I D".
    expect(stripExtensionPrefix(`extension_${APP_A}_sfCostCenterID`)).toBe('sfCostCenterID');
  });

  it('keeps a derived _OuPath suffix (AC2)', () => {
    expect(stripExtensionPrefix(`extension_${APP_A}_fgGroupDN_OuPath`)).toBe('fgGroupDN_OuPath');
  });

  it('also strips the short ext_<appId>_ spelling of the same shape', () => {
    expect(stripExtensionPrefix(`ext_${APP_A}_sfTeamID`)).toBe('sfTeamID');
  });

  it('does not strip our own ext_ export namespace twice over', () => {
    // `ext_` is prepended by the workbook, never stored; if one ever showed up
    // in the data the guid segment is no longer where the rule expects it, and
    // mangling it would be worse than leaving it verbatim.
    const key = `ext_extension_${APP_A}_sfTeamID`;
    expect(stripExtensionPrefix(key)).toBe(key);
  });

  it.each([
    ['extension_nothexnothexnothexnothexnothex_foo', 'non-hex middle segment (AC4)'],
    [`extension_${APP_A.slice(0, 31)}_foo`, '31 hex chars — one short'],
    [`extension_${APP_A}f_foo`, '33 hex chars — one over'],
    [`extension_${APP_A}_`, 'no attribute name after the prefix'],
    ['userType', 'a plain extended-attribute key (AC3)'],
    ['ext_userType', 'our own export namespace with no guid'],
    ['onPremisesDistinguishedName_OuPath', 'a derived key on a non-extension attribute'],
  ])('leaves %s unchanged — %s', (key) => {
    expect(stripExtensionPrefix(key)).toBe(key);
  });

  it('treats null/undefined as an empty key rather than throwing', () => {
    expect(stripExtensionPrefix(null)).toBe('');
    expect(stripExtensionPrefix(undefined)).toBe('');
  });
});

describe('extensionAppId', () => {
  it('returns the appId segment lower-cased', () => {
    expect(extensionAppId(`extension_${APP_A.toUpperCase()}_employeeID`)).toBe(APP_A);
  });

  it('returns null for a key that is not extension-shaped', () => {
    expect(extensionAppId('employeeID')).toBeNull();
  });

  it('is exported as an anchored regex so callers cannot match mid-string', () => {
    expect(EXTENSION_KEY_RE.test(`prefix_extension_${APP_A}_x`)).toBe(false);
  });
});

describe('buildAttributeLabels', () => {
  it('returns only the keys it actually relabels', () => {
    const labels = buildAttributeLabels([`extension_${APP_A}_sfTeamID`, 'userType', 'department']);
    expect(labels).toEqual({ [`extension_${APP_A}_sfTeamID`]: 'sfTeamID' });
  });

  it('disambiguates two apps defining the same attribute (AC6)', () => {
    const keyA = `extension_${APP_A}_employeeID`;
    const keyB = `extension_${APP_B}_employeeID`;
    const labels = buildAttributeLabels([keyA, keyB]);

    expect(labels[keyA]).toBe(`employeeID (${APP_A.slice(0, 8)})`);
    expect(labels[keyB]).toBe(`employeeID (${APP_B.slice(0, 8)})`);
    // Distinguishable — the reject criterion is that they become identical.
    expect(labels[keyA]).not.toBe(labels[keyB]);
    // …and the storage keys are still exactly what was passed in.
    expect(Object.keys(labels).sort()).toEqual([keyA, keyB].sort());
  });

  it('leaves a plain key alone when an extension key strips down to the same name', () => {
    const extKey = `extension_${APP_A}_employeeID`;
    const labels = buildAttributeLabels([extKey, 'employeeID']);

    expect(labels[extKey]).toBe(`employeeID (${APP_A.slice(0, 8)})`);
    expect(labels).not.toHaveProperty('employeeID'); // unchanged ⇒ no entry
  });

  it('prefers the crawler-stamped name over the rule (D4)', () => {
    const key = `extension_${APP_A}_sfCostCenterID`;
    expect(buildAttributeLabels([key], { [key]: 'Cost Centre' })).toEqual({ [key]: 'Cost Centre' });
  });

  it('applies the rule when the stamped map has no entry for the key (D5/AC10)', () => {
    const stamped = `extension_${APP_A}_sfTeamID`;
    const unstamped = `extension_${APP_B}_sfDivisionName`;
    const labels = buildAttributeLabels([stamped, unstamped], { [stamped]: 'Team' });

    expect(labels[stamped]).toBe('Team');
    expect(labels[unstamped]).toBe('sfDivisionName');
  });

  it('never suffixes a stamped label, even when it collides', () => {
    const keyA = `extension_${APP_A}_employeeID`;
    const keyB = `extension_${APP_B}_employeeID`;
    const labels = buildAttributeLabels([keyA, keyB], { [keyA]: 'employeeID' });

    expect(labels[keyA]).toBe('employeeID');                        // the crawler's word is final
    expect(labels[keyB]).toBe(`employeeID (${APP_B.slice(0, 8)})`); // the rule-derived one moves
  });

  it('ignores a blank stamped name and falls back to the rule', () => {
    const key = `extension_${APP_A}_sfTeamID`;
    expect(buildAttributeLabels([key], { [key]: '   ' })).toEqual({ [key]: 'sfTeamID' });
  });

  it('skips non-string and empty keys instead of emitting junk entries (AC5)', () => {
    expect(buildAttributeLabels(['', null, 42, undefined])).toEqual({});
    expect(buildAttributeLabels(undefined)).toEqual({});
  });

  it('does not hand back an Object.prototype member as a label', () => {
    // `constructor` and `toString` are perfectly legal JSON keys, and callers
    // index the result by a key that came from the data.
    const labels = buildAttributeLabels([`extension_${APP_A}_sfTeamID`]);
    expect(labels.constructor).toBeUndefined();
    expect(labels.toString).toBeUndefined();
  });
});

describe('getAttributeLabels', () => {
  beforeEach(() => {
    query.mockReset();
    clearAttributeLabelCache();
  });
  afterEach(() => clearAttributeLabelCache());

  // Stage: overrides query first, then one key query per table scanned.
  const stage = (overrides, ...keySets) => {
    query.mockResolvedValueOnce({ rows: overrides.map(m => ({ m })) });
    for (const keys of keySets) query.mockResolvedValueOnce({ rows: keys.map(k => ({ k })) });
  };

  it('labels one target from its own table', async () => {
    stage([], [`extension_${APP_A}_sAMAccountName`, 'userType']);
    await expect(getAttributeLabels('principal')).resolves.toEqual({
      [`extension_${APP_A}_sAMAccountName`]: 'sAMAccountName',
    });
    expect(query.mock.calls[1][0]).toContain('"Principals"');
  });

  it('unions every target table when none is given', async () => {
    stage([], [`extension_${APP_A}_a`], [`extension_${APP_A}_b`], [], []);
    const labels = await getAttributeLabels();
    expect(labels).toEqual({ [`extension_${APP_A}_a`]: 'a', [`extension_${APP_A}_b`]: 'b' });
    expect(query).toHaveBeenCalledTimes(1 + Object.keys(LABEL_TARGET_TABLES).length);
  });

  it('merges the stamped maps of every system, parsing a raw-string column', async () => {
    const k1 = `extension_${APP_A}_sfTeamID`;
    const k2 = `extension_${APP_B}_sfDivisionID`;
    stage([{ [k1]: 'Team' }, JSON.stringify({ [k2]: 'Division' })], [k1, k2]);
    await expect(getAttributeLabels('principal')).resolves.toEqual({ [k1]: 'Team', [k2]: 'Division' });
  });

  it('tolerates a null / non-object stamped map and still applies the rule', async () => {
    stage([null, '"a bare string"'], [`extension_${APP_A}_x`]);
    await expect(getAttributeLabels('principal')).resolves.toEqual({ [`extension_${APP_A}_x`]: 'x' });
  });

  it('serves the second call from cache instead of re-querying', async () => {
    stage([], [`extension_${APP_A}_sfTeamID`]);
    await getAttributeLabels('principal');
    const callsAfterFirst = query.mock.calls.length;
    await getAttributeLabels('principal');
    expect(query.mock.calls.length).toBe(callsAfterFirst);
  });

  it('reads the stamped maps once and reuses them across targets', async () => {
    // The stamped-map read is cached separately from the per-target key scan, and
    // nothing else in this file reaches that: a repeat call for the SAME target is
    // answered by the label cache before the overrides are consulted at all. Two
    // different targets is the only shape that exercises it, and it is the shape the
    // app actually produces — the filter menus ask for `principal` and `resource`
    // within the same page load.
    const pKey = `extension_${APP_A}_sfTeamID`;
    const rKey = `extension_${APP_B}_sfCostCenterID`;
    stage([{ [pKey]: 'Team' }], [pKey]);
    await expect(getAttributeLabels('principal')).resolves.toEqual({ [pKey]: 'Team' });

    // Only the Resources key scan is staged now — no second overrides recordset.
    // A re-read would consume this one and label the resource key 'Team'.
    query.mockResolvedValueOnce({ rows: [{ k: rKey }] });
    await expect(getAttributeLabels('resource')).resolves.toEqual({ [rKey]: 'sfCostCenterID' });

    const systemsReads = query.mock.calls.filter(c => c[0].includes('"Systems"')).length;
    expect(systemsReads).toBe(1);
  });

  it('caches each target under its own key rather than one shared slot', async () => {
    // Otherwise the second target is served the first one's map — the failure mode
    // is a resource filter menu quietly offering principal attribute names.
    const pKey = `extension_${APP_A}_sfTeamID`;
    const rKey = `extension_${APP_B}_sfCostCenterID`;
    stage([], [pKey]);
    await getAttributeLabels('principal');

    query.mockResolvedValueOnce({ rows: [{ k: rKey }] });
    await expect(getAttributeLabels('resource')).resolves.toEqual({ [rKey]: 'sfCostCenterID' });
  });

  it('re-queries after the cache is cleared', async () => {
    stage([], [`extension_${APP_A}_sfTeamID`]);
    await getAttributeLabels('principal');
    clearAttributeLabelCache();
    stage([], [`extension_${APP_B}_other`]);
    await expect(getAttributeLabels('principal')).resolves.toEqual({ [`extension_${APP_B}_other`]: 'other' });
  });
});

describe('withAttributeLabels', () => {
  beforeEach(() => {
    query.mockReset();
    clearAttributeLabelCache();
  });
  afterEach(() => clearAttributeLabelCache());

  const stage = (keys) => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: keys.map(k => ({ k })) });
  };

  it('labels ext.* entries and leaves real columns and plain ext keys alone (AC3)', async () => {
    stage([`extension_${APP_A}_sfTeamID`, 'userType']);
    const out = await withAttributeLabels([
      { column: 'department', values: ['HR'] },
      { column: `ext.extension_${APP_A}_sfTeamID`, values: ['T1'] },
      { column: 'ext.userType', values: ['Member'] },
    ], 'principal');

    expect(out[0]).toEqual({ column: 'department', values: ['HR'] });
    // The key the UI sends back is untouched — only the label is new (D7/AC8).
    expect(out[1]).toEqual({ column: `ext.extension_${APP_A}_sfTeamID`, values: ['T1'], label: 'sfTeamID' });
    expect(out[2]).not.toHaveProperty('label');
  });

  it('does not overwrite a label a reference field already carries', async () => {
    stage([`extension_${APP_A}_sfTeamID`]);
    const out = await withAttributeLabels([{ column: 'ext.x', label: 'Manager', values: [] }], 'principal');
    expect(out[0].label).toBe('Manager');
  });

  it('returns the columns unchanged when the lookup throws (AC11)', async () => {
    query.mockRejectedValue(new Error('relation "Systems" does not exist'));
    const cols = [{ column: `ext.extension_${APP_A}_sfTeamID`, values: [] }];
    await expect(withAttributeLabels(cols, 'principal')).resolves.toEqual(cols);
  });

  it('short-circuits an empty or non-array column list without querying (AC5)', async () => {
    await expect(withAttributeLabels([], 'principal')).resolves.toEqual([]);
    await expect(withAttributeLabels(null, 'principal')).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('skips null entries in the column list', async () => {
    stage([`extension_${APP_A}_sfTeamID`]);
    await expect(withAttributeLabels([null], 'principal')).resolves.toEqual([null]);
  });
});
