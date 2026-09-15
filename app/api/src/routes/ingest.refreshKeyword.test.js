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

describe('matrixRefreshMinIntervalMs — spacing of piled-up refreshes (SEC-2026-09 M-05)', () => {
  it('defaults to 5 s and honours a non-negative integer override', async () => {
    const { matrixRefreshMinIntervalMs } = await import('./ingest/matrixViews.js');
    expect(matrixRefreshMinIntervalMs({})).toBe(5000);
    expect(matrixRefreshMinIntervalMs({ MATRIX_REFRESH_MIN_INTERVAL_MS: '0' })).toBe(0);
    expect(matrixRefreshMinIntervalMs({ MATRIX_REFRESH_MIN_INTERVAL_MS: '-3' })).toBe(5000);
  });
});
