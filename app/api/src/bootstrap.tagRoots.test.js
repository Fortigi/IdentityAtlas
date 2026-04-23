// Unit tests for the synthetic Tags-root bootstrap helpers in bootstrap.js.
// We mock the db module to keep this test pure (no real Postgres) and
// assert the SQL the helpers issue.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const TAGS_PRINCIPAL_ID = '00000000-0000-0000-0000-000000000001';
const TAGS_RESOURCE_ID  = '00000000-0000-0000-0000-000000000002';
const TAGS_IDENTITY_ID  = '00000000-0000-0000-0000-000000000003';

// State a fake db can answer with: { Principal: <id|null>, Resource: ..., Identity: ... }
async function loadBootstrapWithExistingRoots(existing) {
  vi.resetModules();
  const calls = { queryOne: [], query: [] };

  vi.doMock('./db/connection.js', () => ({
    queryOne: vi.fn(async (sql, params) => {
      calls.queryOne.push({ sql, params });
      // ensureTagRoots SELECT pattern: by contextType + targetType
      const m = /AND "targetType"\s*=\s*\$1/.exec(sql);
      if (m) {
        const id = existing[params[0]];
        return id ? { id } : null;
      }
      return null;
    }),
    query: vi.fn(async (sql, params) => {
      calls.query.push({ sql, params });
      // INSERT — return rowCount 1
      // UPDATE reparent — return rowCount based on caller's expectations
      return { rowCount: 0 };
    }),
  }));
  // Don't actually run runMigrations / ensureBuiltinCrawler etc. — load the
  // module fresh, then call the named export. ensureTagRoots is internal but
  // getOrCreateTagRoot is exported.
  const mod = await import('./bootstrap.js');
  return { ...mod, calls };
}

describe('getOrCreateTagRoot', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns the existing id when a root already exists for the targetType', async () => {
    const { getOrCreateTagRoot, calls } = await loadBootstrapWithExistingRoots({
      Principal: TAGS_PRINCIPAL_ID,
    });
    const id = await getOrCreateTagRoot('Principal');
    expect(id).toBe(TAGS_PRINCIPAL_ID);
    // No INSERT should have been issued.
    expect(calls.query.length).toBe(0);
  });

  it('inserts a new root when none exists and returns its id', async () => {
    const { getOrCreateTagRoot, calls } = await loadBootstrapWithExistingRoots({});
    const id = await getOrCreateTagRoot('Resource');
    // Returned id should be a uuid (randomUUID).
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // One INSERT into Contexts with the right shape.
    expect(calls.query.length).toBe(1);
    expect(calls.query[0].sql).toMatch(/INSERT INTO "Contexts"/);
    expect(calls.query[0].sql).toMatch(/'TagGroup'/);
    expect(calls.query[0].sql).toMatch(/'manual'/);
    // Params: [id, targetType, description]
    expect(calls.query[0].params[0]).toBe(id);
    expect(calls.query[0].params[1]).toBe('Resource');
    expect(calls.query[0].params[2]).toMatch(/Resource tags/);
  });

  it('round-trips three different targetTypes independently', async () => {
    const { getOrCreateTagRoot, calls } = await loadBootstrapWithExistingRoots({
      Principal: TAGS_PRINCIPAL_ID,
      Resource:  TAGS_RESOURCE_ID,
      Identity:  TAGS_IDENTITY_ID,
    });
    expect(await getOrCreateTagRoot('Principal')).toBe(TAGS_PRINCIPAL_ID);
    expect(await getOrCreateTagRoot('Resource')).toBe(TAGS_RESOURCE_ID);
    expect(await getOrCreateTagRoot('Identity')).toBe(TAGS_IDENTITY_ID);
    // Three SELECTs, zero INSERTs since all existed.
    expect(calls.queryOne.length).toBe(3);
    expect(calls.query.length).toBe(0);
  });
});
