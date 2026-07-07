import { describe, it, expect, vi } from 'vitest';
import {
  computeSkew,
  recordComponentVersion,
  getComponentVersion,
  WORKER_STALE_MS,
} from './componentVersions.js';

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
