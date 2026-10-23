// The context-owner access switch (auth/contextOwnerSetting.js): read once from
// WorkerConfig, held in memory, updated in place by the admin route.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/connection.js');
const { query, queryOne } = await import('../db/connection.js');
const {
  CONTEXT_OWNER_ACCESS_KEY, isContextOwnerAccessEnabled, setContextOwnerAccess, resetContextOwnerSettingForTests,
} = await import('./contextOwnerSetting.js');

const savedUseSql = process.env.USE_SQL;

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  resetContextOwnerSettingForTests();
  process.env.USE_SQL = 'true';
});
afterEach(() => {
  if (savedUseSql === undefined) delete process.env.USE_SQL;
  else process.env.USE_SQL = savedUseSql;
});

describe('isContextOwnerAccessEnabled', () => {
  it('is on only for the exact stored value "true"', async () => {
    queryOne.mockResolvedValueOnce({ configValue: 'true' });
    expect(await isContextOwnerAccessEnabled()).toBe(true);
    expect(queryOne.mock.calls[0][1]).toEqual([CONTEXT_OWNER_ACCESS_KEY]);
  });

  it.each([[{ configValue: 'false' }], [{ configValue: 'TRUE ' }], [null]])('is off for %j', async (stored) => {
    queryOne.mockResolvedValueOnce(stored);
    expect(await isContextOwnerAccessEnabled()).toBe(false);
  });

  it('reads the database once and then answers from memory', async () => {
    queryOne.mockResolvedValueOnce({ configValue: 'true' });
    await isContextOwnerAccessEnabled();
    await isContextOwnerAccessEnabled();
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('does not remember a failed read — the next call asks again', async () => {
    queryOne.mockRejectedValueOnce(new Error('relation "WorkerConfig" does not exist'));
    expect(await isContextOwnerAccessEnabled()).toBe(false);
    queryOne.mockResolvedValueOnce({ configValue: 'true' });
    expect(await isContextOwnerAccessEnabled()).toBe(true);
    expect(queryOne).toHaveBeenCalledTimes(2);
  });

  it('is off without a database, and does not query', async () => {
    delete process.env.USE_SQL;
    expect(await isContextOwnerAccessEnabled()).toBe(false);
    expect(queryOne).not.toHaveBeenCalled();
  });
});

describe('setContextOwnerAccess', () => {
  it('stores "true" under the key and is then read from memory', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await setContextOwnerAccess(true)).toBe(true);
    expect(query.mock.calls[0][1]).toEqual([CONTEXT_OWNER_ACCESS_KEY, 'true']);
    expect(await isContextOwnerAccessEnabled()).toBe(true);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('stores "false" when turned off', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await setContextOwnerAccess(false);
    expect(query.mock.calls[0][1]).toEqual([CONTEXT_OWNER_ACCESS_KEY, 'false']);
    expect(await isContextOwnerAccessEnabled()).toBe(false);
  });

  it('keeps the old value when the write fails', async () => {
    queryOne.mockResolvedValueOnce({ configValue: 'false' });
    await isContextOwnerAccessEnabled();
    query.mockRejectedValueOnce(new Error('disk full'));
    await expect(setContextOwnerAccess(true)).rejects.toThrow('disk full');
    expect(await isContextOwnerAccessEnabled()).toBe(false);
  });

  it('refuses a value that is not a boolean, without writing', async () => {
    await expect(setContextOwnerAccess('true')).rejects.toThrow(TypeError);
    expect(query).not.toHaveBeenCalled();
  });

  it('holds the value in memory without a database', async () => {
    delete process.env.USE_SQL;
    await setContextOwnerAccess(true);
    expect(query).not.toHaveBeenCalled();
    expect(await isContextOwnerAccessEnabled()).toBe(true);
  });
});
