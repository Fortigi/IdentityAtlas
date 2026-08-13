// Unit tests for the pure helpers extracted from admin/curatedData.js (#1030):
// the export row-grouping and the import colour default. The DB-bound resolve/
// upsert/attach helpers are covered through admin.coverage.test.js +
// curatedData.contract.test.js.

import { describe, it, expect } from 'vitest';
import { groupExportTags, groupExportCategories } from './curatedExport.js';
import { normalizeCuratedColor } from './curatedImport.js';

describe('groupExportTags', () => {
  it('groups rows by tag id and collects non-null assignments', () => {
    const out = groupExportTags([
      { id: 1, name: 'VIP', color: '#fff', entityType: 'user', entityId: 'u1', entityDisplayName: 'Ann', resourceType: null },
      { id: 1, name: 'VIP', color: '#fff', entityType: 'user', entityId: 'u2', entityDisplayName: null, resourceType: null },
      { id: 2, name: 'Empty', color: '#000', entityType: 'group', entityId: null },
    ]);
    expect(out).toEqual([
      { name: 'VIP', color: '#fff', entityType: 'user', assignments: [
        { entityId: 'u1', displayName: 'Ann', resourceType: null },
        { entityId: 'u2', displayName: null, resourceType: null },
      ] },
      { name: 'Empty', color: '#000', entityType: 'group', assignments: [] },
    ]);
  });
  it('returns [] for no rows', () => {
    expect(groupExportTags([])).toEqual([]);
  });
});

describe('groupExportCategories', () => {
  it('groups rows by category id and collects AP assignments', () => {
    const out = groupExportCategories([
      { id: 'c1', name: 'Fin', color: '#111', resourceId: 'ap1', businessRoleDisplayName: 'Finance' },
      { id: 'c1', name: 'Fin', color: '#111', resourceId: null },
    ]);
    expect(out).toEqual([
      { name: 'Fin', color: '#111', assignments: [
        { accessPackageId: 'ap1', accessPackageDisplayName: 'Finance' },
      ] },
    ]);
  });
});

describe('normalizeCuratedColor', () => {
  it('keeps a valid #rrggbb colour', () => {
    expect(normalizeCuratedColor('#a1b2c3')).toBe('#a1b2c3');
  });
  it('falls back to the default blue for invalid/empty input', () => {
    expect(normalizeCuratedColor('red')).toBe('#3b82f6');
    expect(normalizeCuratedColor('')).toBe('#3b82f6');
    expect(normalizeCuratedColor(undefined)).toBe('#3b82f6');
    expect(normalizeCuratedColor('#fff')).toBe('#3b82f6'); // 3-digit not accepted
  });
});
