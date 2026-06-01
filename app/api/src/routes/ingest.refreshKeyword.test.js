import { describe, it, expect } from 'vitest';
import { refreshKeyword } from './ingest.js';

describe('refreshKeyword — CONCURRENTLY guard', () => {
  const populated = new Set(['vw_ResourceUserPermissionAssignments']);

  it('returns CONCURRENTLY when not desktop and view is populated', () => {
    expect(refreshKeyword('vw_ResourceUserPermissionAssignments', populated, false))
      .toBe('CONCURRENTLY');
  });

  it('returns empty string in DESKTOP_MODE even when view is populated', () => {
    expect(refreshKeyword('vw_ResourceUserPermissionAssignments', populated, true))
      .toBe('');
  });

  it('returns empty string when view is not yet populated (first boot)', () => {
    expect(refreshKeyword('vw_ResourceUserPermissionAssignments', new Set(), false))
      .toBe('');
  });

  it('returns empty string for an unpopulated view in DESKTOP_MODE', () => {
    expect(refreshKeyword('vw_ResourceUserPermissionAssignments', new Set(), true))
      .toBe('');
  });
});
