// Unit tests for perf/sqlTimer.js — the native-pg timedQuery helper (#663) and
// the legacy timedRequest wrapper. The collector's isEnabled() is mocked so we
// control the timed vs pass-through paths.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ enabled: true }));
vi.mock('./collector.js', () => ({ isEnabled: () => state.enabled }));

const { timedQuery, getQueryTimings } = await import('./sqlTimer.js');

beforeEach(() => { state.enabled = true; });

describe('timedQuery', () => {
  it('runs pool.query with (text, params) and records a timing with the row count', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ a: 1 }, { a: 2 }] }) };
    const res = {};
    const result = await timedQuery(pool, 'lbl', res, 'SELECT $1', [7]);
    expect(pool.query).toHaveBeenCalledWith('SELECT $1', [7]);
    expect(result.rows).toHaveLength(2);
    const t = getQueryTimings(res);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ label: 'lbl', rows: 2 });
    expect(typeof t[0].ms).toBe('number');
  });

  it('records an error timing and rethrows on failure', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('boom')) };
    const res = {};
    await expect(timedQuery(pool, 'lbl', res, 'SELECT 1')).rejects.toThrow('boom');
    expect(getQueryTimings(res)[0]).toMatchObject({ label: 'lbl', error: 'boom' });
  });

  it('defaults params to an empty array', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await timedQuery(pool, 'lbl', {}, 'SELECT 1');
    expect(pool.query).toHaveBeenCalledWith('SELECT 1', []);
  });

  it('passes through without recording when the collector is disabled', async () => {
    state.enabled = false;
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const res = {};
    await timedQuery(pool, 'lbl', res, 'SELECT 1');
    expect(getQueryTimings(res)).toHaveLength(0);
  });

  it('passes through without recording when there is no res', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ x: 1 }] }) };
    const result = await timedQuery(pool, 'lbl', null, 'SELECT 1');
    expect(result.rows).toEqual([{ x: 1 }]);
  });
});
