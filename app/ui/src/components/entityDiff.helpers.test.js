import { describe, it, expect, afterEach } from 'vitest';
import {
  diffSnapshots, onlyChanges, daysAgoIso, dateInputToIso, isoToDateInput, attributeDisplayLabel,
} from './entityDiff.helpers';
import { setAttributeLabels } from '@ui/utils/attributeLabels';

const item = (key, group, label, extra = {}) => ({ key, group, label, kind: 'resource', id: key, detail: '', ...extra });

describe('diffSnapshots — attributes', () => {
  const before = { attributes: { department: 'Sales', jobTitle: 'Rep', city: 'Utrecht', mobile: '', accountEnabled: true } };
  const after = { attributes: { department: 'Finance', jobTitle: 'Rep', country: 'NL', accountEnabled: false } };

  it('classifies each attribute as changed, added, removed or unchanged', () => {
    const { attributes } = diffSnapshots(before, after);
    const byKey = Object.fromEntries(attributes.map(r => [r.key, r.status]));
    expect(byKey).toEqual({
      department: 'changed', jobTitle: 'unchanged', city: 'removed', country: 'added', accountEnabled: 'changed',
    });
    // Empty on both sides (mobile: '' vs missing) is not a row at all.
    expect(attributes.some(r => r.key === 'mobile')).toBe(false);
  });

  it('compares objects by value, not identity', () => {
    const { attributes } = diffSnapshots(
      { attributes: { tags: { a: 1 } } }, { attributes: { tags: { a: 1 } } });
    expect(attributes[0].status).toBe('unchanged');
  });

  it('sorts core attributes A→Z by label, extended ones after', () => {
    const { attributes } = diffSnapshots(
      { attributes: { 'ext.zeta': 1, title: 'x', 'ext.alpha': 1, department: 'y' } }, { attributes: {} });
    expect(attributes.map(r => r.key)).toEqual(['department', 'title', 'ext.alpha', 'ext.zeta']);
    expect(attributes[2].extended).toBe(true);
  });

  it('treats a side without a snapshot as empty', () => {
    const { attributes, counts } = diffSnapshots(null, { attributes: { department: 'Finance' } });
    expect(attributes[0]).toMatchObject({ key: 'department', status: 'added' });
    expect(counts).toEqual({ added: 1, removed: 0, changed: 0, unchanged: 0 });
  });
});

describe('diffSnapshots — relationships', () => {
  const before = { attributes: {}, relationships: [
    item('m-old', 'Manager', 'Alice'),
    item('g-1', 'Groups', 'Finance Team'),
    item('br-1', 'Business roles', 'Sales Rep'),
  ] };
  const after = { attributes: {}, relationships: [
    item('m-new', 'Manager', 'Bob'),
    item('g-1', 'Groups', 'Finance Team'),
    item('br-2', 'Business roles', 'Analyst'),
    item('x-1', 'Archive', 'Old stuff'),
  ] };

  it('aligns items by key and orders groups: known ones first, then A→Z', () => {
    const { groups } = diffSnapshots(before, after);
    expect(groups.map(g => g.group)).toEqual(['Manager', 'Business roles', 'Archive', 'Groups']);
    const roles = groups.find(g => g.group === 'Business roles');
    // Rows sorted by label: Analyst (added) before Sales Rep (removed).
    expect(roles.rows.map(r => [r.key, r.status, !!r.before, !!r.after])).toEqual([
      ['br-2', 'added', false, true],
      ['br-1', 'removed', true, false],
    ]);
    expect(roles).toMatchObject({ beforeCount: 1, afterCount: 1 });
    const grp = groups.find(g => g.group === 'Groups');
    expect(grp.rows[0]).toMatchObject({ status: 'unchanged' });
  });

  it('counts attribute and relationship rows together', () => {
    const { counts } = diffSnapshots(
      { ...before, attributes: { department: 'Sales' } }, { ...after, attributes: { department: 'Finance' } });
    expect(counts).toEqual({ added: 3, removed: 2, changed: 1, unchanged: 1 });
  });

  it('onlyChanges drops unchanged rows and the groups they leave empty', () => {
    const filtered = onlyChanges(diffSnapshots(
      { attributes: { a: 1, b: 1 }, relationships: before.relationships },
      { attributes: { a: 1, b: 2 }, relationships: after.relationships }));
    expect(filtered.attributes.map(r => r.key)).toEqual(['b']);
    expect(filtered.groups.map(g => g.group)).not.toContain('Groups');
    expect(filtered.groups.map(g => g.group)).toContain('Manager');
  });
});

describe('date helpers', () => {
  it('daysAgoIso subtracts whole days', () => {
    expect(daysAgoIso(2, new Date('2026-10-27T12:00:00Z'))).toBe('2026-10-25T12:00:00.000Z');
  });
  it('dateInputToIso turns YYYY-MM-DD into local midnight, rejecting junk', () => {
    const iso = dateInputToIso('2026-03-15');
    const d = new Date(iso);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 2, 15, 0, 0]);
    expect(dateInputToIso('')).toBeNull();
    expect(dateInputToIso('15-03-2026')).toBeNull();
  });
  it('isoToDateInput round-trips and is empty for junk', () => {
    expect(isoToDateInput(dateInputToIso('2026-01-05'))).toBe('2026-01-05');
    expect(isoToDateInput('nope')).toBe('');
  });
});

describe('attributeDisplayLabel', () => {
  afterEach(() => setAttributeLabels({}));
  it('humanises core keys and uses the server label for extended keys, else the raw name', () => {
    setAttributeLabels({ extension_abc_sAMAccountName: 'sAMAccountName' });
    expect(attributeDisplayLabel('jobTitle')).toBe('Job Title');
    expect(attributeDisplayLabel('ext.extension_abc_sAMAccountName')).toBe('sAMAccountName');
    expect(attributeDisplayLabel('ext.costCenter')).toBe('costCenter');
  });
});
