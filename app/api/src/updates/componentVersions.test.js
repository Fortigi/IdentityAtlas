import { describe, it, expect, vi } from 'vitest';
import {
  computeSkew,
  recordComponentVersion,
  getComponentVersion,
  shouldStampSchemaVersion,
  stampSchemaVersion,
  WORKER_STALE_MS,
} from './componentVersions.js';
import { getMigrationStatus } from '../db/migrate.js';

vi.mock('../db/migrate.js', () => ({ getMigrationStatus: vi.fn() }));

describe('computeSkew', () => {
  const NOW = 1_700_000_000_000;
  const seenNow = new Date(NOW).toISOString();

  it('matched web+worker → no mismatch, not stale, known', () => {
    const s = computeSkew('5.310.20260629.1221', { version: '5.310.20260629.1221', lastSeenAt: seenNow }, NOW);
    expect(s).toEqual({ mismatch: false, workerStale: false, workerKnown: true });
  });

  it('different versions → mismatch', () => {
    const s = computeSkew('5.310.20260629.1221', { version: '5.309.20260628.1000', lastSeenAt: seenNow }, NOW);
    expect(s.mismatch).toBe(true);
  });

  it('worker last seen beyond the stale window → workerStale', () => {
    const stale = new Date(NOW - WORKER_STALE_MS - 1000).toISOString();
    const s = computeSkew('5.310', { version: '5.310', lastSeenAt: stale }, NOW);
    expect(s.workerStale).toBe(true);
  });

  it('worker never reported → unknown, no mismatch', () => {
    expect(computeSkew('5.310', null, NOW)).toEqual({ mismatch: false, workerStale: false, workerKnown: false });
  });

  it('web version unknown → no mismatch even if worker is known', () => {
    const s = computeSkew(null, { version: '5.310', lastSeenAt: seenNow }, NOW);
    expect(s.mismatch).toBe(false);
    expect(s.workerKnown).toBe(true);
  });
});

describe('recordComponentVersion', () => {
  it('no-ops when component or version is missing', async () => {
    const client = { query: vi.fn() };
    await recordComponentVersion('worker', null, client);
    await recordComponentVersion(null, '5.310', client);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('upserts (component, version) on valid input', async () => {
    const client = { query: vi.fn().mockResolvedValue({}) };
    await recordComponentVersion('worker', '5.310', client);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][1]).toEqual(['worker', '5.310']);
  });
});

describe('getComponentVersion', () => {
  it('returns the row, or null when absent', async () => {
    const row = { component: 'worker', version: '5.310', lastSeenAt: 'x' };
    expect(await getComponentVersion('worker', { query: vi.fn().mockResolvedValue({ rows: [row] }) })).toEqual(row);
    expect(await getComponentVersion('worker', { query: vi.fn().mockResolvedValue({ rows: [] }) })).toBeNull();
  });
});

describe('shouldStampSchemaVersion', () => {
  const clean = { pending: false, ahead: false };
  it('stamps when migrations complete, DB not ahead, no existing stamp', () => {
    expect(shouldStampSchemaVersion('5.410.0', clean, null)).toBe(true);
  });
  it('skips when the version is unknown', () => {
    expect(shouldStampSchemaVersion(null, clean, null)).toBe(false);
  });
  it('skips when migrations are still pending (needed scripts have not run)', () => {
    expect(shouldStampSchemaVersion('5.410.0', { pending: true, ahead: false }, null)).toBe(false);
  });
  it('skips when the DB is ahead of this code (rollback)', () => {
    expect(shouldStampSchemaVersion('5.408.0', { pending: false, ahead: true }, null)).toBe(false);
  });
  it('never downgrades over a newer existing stamp', () => {
    expect(shouldStampSchemaVersion('5.408.0', clean, { version: '5.410.0' })).toBe(false);
  });
  it('re-stamps the same or a newer version', () => {
    expect(shouldStampSchemaVersion('5.410.0', clean, { version: '5.410.0' })).toBe(true);
    expect(shouldStampSchemaVersion('5.411.0', clean, { version: '5.410.0' })).toBe(true);
  });
});

describe('stampSchemaVersion', () => {
  it('stamps the DB version when migrations are complete', async () => {
    getMigrationStatus.mockResolvedValue({ pending: false, ahead: false });
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }; // no existing row; insert ok
    expect(await stampSchemaVersion('5.410.0', client)).toBe('5.410.0');
    const insert = client.query.mock.calls.find((c) => /INSERT/i.test(c[0]));
    expect(insert[1]).toEqual(['database', '5.410.0']);
  });

  it('does not stamp (or downgrade) when the DB schema is ahead of the code', async () => {
    getMigrationStatus.mockResolvedValue({ pending: false, ahead: true });
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await stampSchemaVersion('5.408.0', client)).toBeNull();
    expect(client.query.mock.calls.some((c) => /INSERT/i.test(c[0]))).toBe(false);
  });
});
