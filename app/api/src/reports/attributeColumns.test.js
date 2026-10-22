// Every entitlement attribute as a column. The inputs discriminate: keys whose
// fill counts differ, so "keep the most-filled" and "keep the first
// alphabetically" give different answers; a picked key that must not repeat;
// a key holding only blanks; and a key whose heading collides with a column.

import { describe, it, expect } from 'vitest';
import {
  MAX_ATTRIBUTE_COLUMNS, MEMBER_ATTRIBUTES, attributeColumns, attributeKeyCounts, omittedAttributeNotices,
} from './attributeColumns.js';
import { resolveFields } from './accessReviewFields.js';

const ent = extendedAttributes => ({ id: Math.random().toString(36), extendedAttributes });
const keysOf = fields => fields.map(f => f.key);

describe('attributeKeyCounts', () => {
  it('counts only values that say something, and survives rows without attributes', () => {
    const counts = attributeKeyCounts([
      ent({ requestable: false, certfrequency: 'Annually', blank: '  ', none: null }),
      ent({ requestable: true, zero: 0 }),
      ent(null),
      { id: 'x' },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ requestable: 2, certfrequency: 1, zero: 1 });
  });
});

describe('attributeColumns', () => {
  it('adds the union of keys over the rows, sorted, skipping one already picked', () => {
    const picked = resolveFields(['entitlement.ext.ownerId']).fields;
    const { fields, omitted } = attributeColumns([
      ent({ requestable: true, ownerId: 'o1' }),
      ent({ certfrequency: 'Quarterly', Zeta: 1, alpha: 'x' }),
    ], picked);
    expect(keysOf(fields)).toEqual([
      'entitlement.ext.alpha', 'entitlement.ext.certfrequency', 'entitlement.ext.requestable', 'entitlement.ext.Zeta',
    ]);
    expect(fields.map(f => f.label)).toEqual(['alpha', 'certfrequency', 'requestable', 'Zeta']);
    expect(omitted).toEqual([]);
    // A field reads its own key from the row it is given.
    expect(fields[2].read({ entitlement: { extendedAttributes: { requestable: true } } })).toBe(true);
  });

  it('keeps the keys most entitlements carry when there are more than the cap, and names the rest', () => {
    const rows = [
      ent({ common: 1, rare: 1, mid: 1 }),
      ent({ common: 1, mid: 1 }),
      ent({ common: 1, aaa: 1 }),
    ];
    // Cap 2: common (3) and mid (2) win; aaa and rare (1 each) are left out —
    // alphabetical order alone would have kept aaa.
    const { fields, omitted } = attributeColumns(rows, [], [], { max: 2 });
    expect(keysOf(fields)).toEqual(['entitlement.ext.common', 'entitlement.ext.mid']);
    expect(omitted).toEqual(['aaa', 'rare']);
  });

  it('counts a key that cannot be a field key among the left-out ones', () => {
    const { fields, omitted } = attributeColumns([ent({ 'a,b': 'x', ok: 'y' })], []);
    expect(keysOf(fields)).toEqual(['entitlement.ext.ok']);
    expect(omitted).toEqual(['a,b']);
  });

  it('heads a column whose name repeats an existing heading as an attribute', () => {
    const { fields } = attributeColumns([ent({ System: 'SAP', entitlement: 'x', other: 1 })], [], ['Entitlement', 'System']);
    expect(fields.map(f => f.label)).toEqual(['Attribute · entitlement', 'other', 'Attribute · System']);
  });

  it('caps at 60 by default', () => {
    const attrs = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]));
    const { fields, omitted } = attributeColumns([ent(attrs)], []);
    expect(MAX_ATTRIBUTE_COLUMNS).toBe(60);
    expect(fields).toHaveLength(60);
    expect(omitted).toEqual(['k60', 'k61', 'k62', 'k63', 'k64']);
  });
});

describe('member attributes', () => {
  it('reads a unit member\'s attributes under member keys, and says "member" in the notice', () => {
    const { fields, omitted } = attributeColumns(
      [{ extendedAttributes: { costCenter: 'FIN-01', extension_0123456789abcdef0123456789abcdef_badge: 7, z: 1 } }],
      [], [], { max: 2, kind: MEMBER_ATTRIBUTES });
    expect(fields.map(f => [f.key, f.label])).toEqual([
      ['member.ext.costCenter', 'costCenter'],
      ['member.ext.extension_0123456789abcdef0123456789abcdef_badge', 'badge'],
    ]);
    expect(fields[0].read({ member: { extendedAttributes: { costCenter: 'FIN-01' } } })).toBe('FIN-01');
    expect(fields[0].read({})).toBeNull();
    const [notice] = omittedAttributeNotices(omitted, { max: 2, kind: MEMBER_ATTRIBUTES });
    expect(notice.text).toBe('1 member attribute(s) are not shown as columns (a run shows at most 2, the ones most members carry): "z".');
  });
});

describe('omittedAttributeNotices', () => {
  it('says nothing when every attribute is a column', () => {
    expect(omittedAttributeNotices([])).toEqual([]);
  });

  it('names the left-out keys, and counts the rest past twenty', () => {
    const [few] = omittedAttributeNotices(['b', 'a'], { max: 60 });
    expect(few.text).toBe('2 entitlement attribute(s) are not shown as columns (a run shows at most 60, '
      + 'the ones most entitlements carry): "b", "a". Pick any of them under Columns to include it.');
    const many = Array.from({ length: 23 }, (_, i) => `k${i}`);
    const [notice] = omittedAttributeNotices(many, { max: 60 });
    expect(notice.text).toContain('"k19" and 3 more.');
    expect(notice.text).not.toContain('"k20"');
  });
});
