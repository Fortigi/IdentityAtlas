import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as db from '../db/connection.js';

vi.mock('../db/connection.js', () => ({
  queryOne: vi.fn(),
}));

const { getSyncVersion, bumpSyncVersion } = await import('./syncVersion.js');

describe('getSyncVersion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 0 when the row is absent (fresh install)', async () => {
    db.queryOne.mockResolvedValue(null);
    expect(await getSyncVersion()).toBe(0);
  });

  it('parses the stored text value to a number', async () => {
    db.queryOne.mockResolvedValue({ configValue: '42' });
    expect(await getSyncVersion()).toBe(42);
  });

  it('falls back to 0 on a non-numeric value', async () => {
    db.queryOne.mockResolvedValue({ configValue: 'not-a-number' });
    expect(await getSyncVersion()).toBe(0);
  });
});

describe('bumpSyncVersion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the incremented value the upsert reports', async () => {
    db.queryOne.mockResolvedValue({ configValue: '7' });
    expect(await bumpSyncVersion()).toBe(7);
  });

  it('uses an INSERT ... ON CONFLICT upsert that increments the existing value', async () => {
    db.queryOne.mockResolvedValue({ configValue: '1' });
    await bumpSyncVersion();
    const sql = db.queryOne.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO "WorkerConfig"/);
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/\+ 1/);
  });
});
