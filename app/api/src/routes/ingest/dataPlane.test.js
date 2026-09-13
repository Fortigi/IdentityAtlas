// Unit tests for the crawler data-plane decisions (SEC-2026-09 M-05).

import { describe, it, expect } from 'vitest';
import { buildSyncLogRow, classifyScope } from './dataPlane.js';

const WORKER = { id: 1, systemIds: null };
const RESTRICTED = { id: 21, systemIds: [7, 8] };
const START = '2026-01-01T00:00:00Z';

describe('buildSyncLogRow', () => {
  it('requires syncType and startTime', () => {
    expect(buildSyncLogRow({ startTime: START }, WORKER)).toEqual({ status: 400, error: 'syncType and startTime are required' });
    expect(buildSyncLogRow(undefined, WORKER).status).toBe(400);
  });

  it('stamps the authenticated crawler, and no system when none is named', () => {
    const row = buildSyncLogRow({ syncType: 'CSV-FullCrawl', startTime: START, endTime: '2026-01-01T00:01:30Z' }, RESTRICTED);
    expect(row.duration).toBe(90);
    expect(row.values).toEqual(['CSV-FullCrawl', null, new Date(START), new Date('2026-01-01T00:01:30Z'), 90, 0, 'Success', null, 21, null]);
  });

  it('stamps a system the crawler may access, given as a string or a number', () => {
    expect(buildSyncLogRow({ syncType: 'X', startTime: START, systemId: '8' }, RESTRICTED).values.at(-1)).toBe(8);
    expect(buildSyncLogRow({ syncType: 'X', startTime: START, systemId: 99 }, WORKER).values.at(-1)).toBe(99);
  });

  it('refuses a system outside the allow-list (403) and a malformed one (400)', () => {
    expect(buildSyncLogRow({ syncType: 'X', startTime: START, systemId: 9 }, RESTRICTED).status).toBe(403);
    expect(buildSyncLogRow({ syncType: 'X', startTime: START, systemId: 'abc' }, RESTRICTED).status).toBe(400);
    expect(buildSyncLogRow({ syncType: 'X', startTime: START, systemId: 0 }, WORKER).status).toBe(400);
  });

  it('refuses dates that do not parse instead of writing Invalid Date', () => {
    expect(buildSyncLogRow({ syncType: 'X', startTime: 'yesterday-ish' }, WORKER).status).toBe(400);
    expect(buildSyncLogRow({ syncType: 'X', startTime: START, endTime: 'nope' }, WORKER).status).toBe(400);
  });

  it('caps text fields and keeps a caller-supplied status and record count', () => {
    const row = buildSyncLogRow({
      syncType: 'S'.repeat(150), tableName: 'T'.repeat(150), startTime: START, endTime: START,
      recordCount: 12, status: 'Warning', errorMessage: 'E'.repeat(5000),
    }, WORKER);
    const [syncType, tableName, , , duration, count, status, errorMessage] = row.values;
    expect(syncType).toHaveLength(100);
    expect(tableName).toHaveLength(100);
    expect(duration).toBe(0);
    expect(count).toBe(12);
    expect(status).toBe('Warning');
    expect(errorMessage).toHaveLength(4000);
  });

  it('never writes a negative duration or a non-integer record count', () => {
    const row = buildSyncLogRow({ syncType: 'X', startTime: '2026-01-02T00:00:00Z', endTime: START, recordCount: -5 }, WORKER);
    expect(row.duration).toBe(0);
    expect(row.values[5]).toBe(0);
  });
});

describe('classifyScope', () => {
  it('keeps the tenant-wide pass for an unrestricted key that names no system', () => {
    expect(classifyScope({}, WORKER)).toEqual({ clause: '', params: [] });
  });

  it('limits a restricted key that names no system to its own systems', () => {
    expect(classifyScope(undefined, RESTRICTED)).toEqual({ clause: ' AND ra."systemId" = ANY($1::int[])', params: [[7, 8]] });
  });

  it('limits to the named system when the caller may access it', () => {
    expect(classifyScope({ systemId: 7 }, RESTRICTED)).toEqual({ clause: ' AND ra."systemId" = $1', params: [7] });
    expect(classifyScope({ systemId: 3 }, WORKER)).toEqual({ clause: ' AND ra."systemId" = $1', params: [3] });
  });

  it('refuses a named system outside the allow-list, and a malformed one', () => {
    expect(classifyScope({ systemId: 9 }, RESTRICTED)).toEqual({ status: 403, error: 'Crawler does not have access to system 9' });
    expect(classifyScope({ systemId: -1 }, WORKER).status).toBe(400);
  });
});
