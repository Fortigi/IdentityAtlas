// Unit tests for seedContextAlgorithms — db mocked, so no real database.
// Focus: every registered plugin is upserted, and algorithms whose plugin was
// removed/merged out of the registry get DISABLED (not deleted).

import { describe, it, expect, vi } from 'vitest';

const calls = { query: [], queryOne: [] };

async function load({ existing = false } = {}) {
  vi.resetModules();
  calls.query = [];
  calls.queryOne = [];
  vi.doMock('../db/connection.js', () => ({
    queryOne: vi.fn(async (sql, args) => { calls.queryOne.push({ sql, args }); return existing ? { id: 'x' } : null; }),
    query: vi.fn(async (sql, args) => { calls.query.push({ sql, args }); return { rows: [], rowCount: 0 }; }),
  }));
  const seed = await import('./seedAlgorithms.js');
  const reg = await import('./plugins/registry.js');
  return { seedContextAlgorithms: seed.seedContextAlgorithms, REGISTERED_PLUGINS: reg.REGISTERED_PLUGINS };
}

const disableCall = () =>
  calls.query.find(c => /SET enabled = FALSE WHERE enabled = TRUE AND name <> ALL/.test(c.sql));

describe('seedContextAlgorithms', () => {
  it('inserts absent plugins, then disables orphaned algorithms', async () => {
    const { seedContextAlgorithms, REGISTERED_PLUGINS } = await load({ existing: false });
    await seedContextAlgorithms();

    expect(calls.queryOne).toHaveLength(REGISTERED_PLUGINS.length); // one lookup per plugin
    const inserts = calls.query.filter(c => /INSERT INTO "ContextAlgorithms"/.test(c.sql));
    expect(inserts).toHaveLength(REGISTERED_PLUGINS.length);

    const disable = disableCall();
    expect(disable).toBeTruthy();
    expect([...disable.args[0]].sort()).toEqual(REGISTERED_PLUGINS.map(p => p.name).sort());
  });

  it('updates existing rows, then still disables orphans', async () => {
    const { seedContextAlgorithms, REGISTERED_PLUGINS } = await load({ existing: true });
    await seedContextAlgorithms();

    const updates = calls.query.filter(c => /UPDATE "ContextAlgorithms"\s+SET "displayName"/.test(c.sql));
    expect(updates).toHaveLength(REGISTERED_PLUGINS.length);
    expect(disableCall()).toBeTruthy();
  });

  it('keeps the merged risky-consent active and excludes the removed risky-app-consent', async () => {
    const { seedContextAlgorithms } = await load({ existing: false });
    await seedContextAlgorithms();
    const active = disableCall().args[0];
    expect(active).toContain('risky-consent');
    expect(active).not.toContain('risky-app-consent'); // merged away — must not be in the keep-set
  });
});
