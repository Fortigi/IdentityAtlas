// Ingest sessions — the open-session caps and session ownership (SEC-2026-09 M-07 / H-04).
//
// Every open session pins a pooled connection until it ends or times out, so an
// uncapped number of them lets one crawler key starve the pool. These drive the
// real sessions.js with only db/connection mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/connection.js');
import { query, getPool } from '../db/connection.js';
import {
  sessionLimits, sessionLimitDenial, startSession, hasSession, endSession, SessionLimitError,
} from './sessions.js';

const RECORDS = [{ identityId: 'i1', principalId: 'p1' }];
const KEYS = ['identityId', 'principalId'];
let released;
let connectFails;

beforeEach(() => {
  released = 0;
  connectFails = null;
  query.mockReset();
  query.mockImplementation(async (sql) => {
    if (/information_schema\.columns/.test(String(sql))) {
      return { rows: KEYS.map((column_name) => ({ column_name })), rowCount: 2 };
    }
    if (connectFails && connectFails.test(String(sql))) throw new Error('boom');
    return { rows: [], rowCount: 0 };
  });
  getPool.mockResolvedValue({
    connect: async () => ({ query: (...a) => query(...a), release: () => { released++; } }),
  });
});

describe('sessionLimits', () => {
  it('defaults to 7 open sessions in total and 3 per crawler', () => {
    expect(sessionLimits({})).toEqual({ maxGlobal: 7, maxPerCrawler: 3 });
  });

  it('honours positive integer overrides and ignores unusable ones', () => {
    expect(sessionLimits({ INGEST_MAX_SESSIONS_GLOBAL: '4', INGEST_MAX_SESSIONS_PER_CRAWLER: '1' }))
      .toEqual({ maxGlobal: 4, maxPerCrawler: 1 });
    expect(sessionLimits({ INGEST_MAX_SESSIONS_GLOBAL: '0', INGEST_MAX_SESSIONS_PER_CRAWLER: 'x' }))
      .toEqual({ maxGlobal: 7, maxPerCrawler: 3 });
  });
});

describe('sessionLimitDenial', () => {
  const limits = { maxGlobal: 3, maxPerCrawler: 2 };
  const open = (...ids) => ids.map((crawlerId) => ({ crawlerId }));

  it('allows a crawler its second session and refuses its third (the cap is inclusive of open ones)', () => {
    expect(sessionLimitDenial(open(5), 5, false, limits)).toBeNull();
    expect(sessionLimitDenial(open(5, 5), 5, false, limits)).toMatch(/for this crawler \(limit 2\)/);
  });

  it('counts only the calling crawler\'s sessions against the per-crawler cap', () => {
    expect(sessionLimitDenial(open(9, 9), 5, false, limits)).toBeNull();
  });

  it('refuses anyone once the global cap is reached — the worker included', () => {
    expect(sessionLimitDenial(open(1, 2, 9), 5, false, limits)).toMatch(/Too many open ingest sessions \(limit 3\)/);
    expect(sessionLimitDenial(open(1, 2, 9), 1, true, limits)).toMatch(/limit 3/);
  });

  it('exempts a worker-class key from the per-crawler cap only', () => {
    expect(sessionLimitDenial(open(1, 1), 1, true, limits)).toBeNull();
  });

  it('does not count sessions that are already released', () => {
    expect(sessionLimitDenial([{ crawlerId: 5, released: true }, { crawlerId: 5 }], 5, false, limits)).toBeNull();
  });
});

describe('startSession — caps, ownership and connection hygiene', () => {
  it('refuses a session past the per-crawler cap without checking out a connection', async () => {
    const opened = [];
    for (let i = 0; i < 3; i++) opened.push(await startSession(null, 'IdentityMembers', KEYS, RECORDS, { crawlerId: 41 }));
    getPool.mockClear();
    await expect(startSession(null, 'IdentityMembers', KEYS, RECORDS, { crawlerId: 41 }))
      .rejects.toBeInstanceOf(SessionLimitError);
    expect(getPool).not.toHaveBeenCalled();
    for (const s of opened) await endSession(s.syncId, null, [], KEYS, { syncMode: 'delta' });
  });

  it('concurrent starts cannot all slip past the cap (the slot is reserved before the first await)', async () => {
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map(() => startSession(null, 'IdentityMembers', KEYS, RECORDS, { crawlerId: 42 })));
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof SessionLimitError)).toBe(true);
    for (const r of ok) await endSession(r.value.syncId, null, [], KEYS, { syncMode: 'delta' });
  });

  it('a session is invisible to another crawler presenting its syncId', async () => {
    const { syncId } = await startSession(null, 'IdentityMembers', KEYS, RECORDS, { crawlerId: 43 });
    expect(hasSession(syncId, 43)).toBe(true);
    expect(hasSession(syncId, 44)).toBe(false);
    expect(hasSession(syncId)).toBe(true); // internal callers pass no crawler
    await endSession(syncId, null, [], KEYS, { syncMode: 'delta' });
    expect(hasSession(syncId, 43)).toBe(false);
  });

  it('raises the idle-in-transaction timeout for its own transaction only', async () => {
    const { syncId } = await startSession(null, 'IdentityMembers', KEYS, RECORDS, { crawlerId: 45 });
    const set = query.mock.calls.map((c) => String(c[0])).find((s) => /idle_in_transaction_session_timeout/.test(s));
    expect(set).toBe('SET LOCAL idle_in_transaction_session_timeout = 1800000');
    await endSession(syncId, null, [], KEYS, { syncMode: 'delta' });
  });

  it('releases the connection and frees the slot when the session fails to open', async () => {
    connectFails = /CREATE TEMP TABLE/;
    await expect(startSession(null, 'IdentityMembers', KEYS, RECORDS, { crawlerId: 46 })).rejects.toThrow('boom');
    expect(released).toBe(1);
    connectFails = null;
    // All three slots are free again for this crawler.
    const opened = [];
    for (let i = 0; i < 3; i++) opened.push(await startSession(null, 'IdentityMembers', KEYS, RECORDS, { crawlerId: 46 }));
    for (const s of opened) await endSession(s.syncId, null, [], KEYS, { syncMode: 'delta' });
  });

  it('carries restrictSystemIds to the end-of-session reconcile', async () => {
    const { syncId } = await startSession(null, 'IdentityMembers', KEYS, RECORDS,
      { crawlerId: 47, systemId: 7, scope: {}, restrictSystemIds: [7] });
    await endSession(syncId, null, [], KEYS, { syncMode: 'full' });
    const del = query.mock.calls.find((c) => /DELETE FROM "IdentityMembers"/.test(String(c[0])));
    expect(del[0]).toContain('op."systemId" = ANY($1::int[])');
    expect(del[1]).toEqual([[7]]);
  });
});
