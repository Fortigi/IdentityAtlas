// The owner-access service: kinds, the context shortcut, and the two caches.
// The pool is a fake whose rows say which ids are on the team or held, so every
// case can tell "classified as X" from "not classified at all".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOwnerAccess, normaliseKind, clearOwnerAccessCache, CACHE_TTL_MS } from './ownerAccess.js';
import { createLru } from '../../effectiveAccess/lru.js';
import { TIER_SQL } from './tiers.js';

const CTX = 'cccccccc-0000-4000-8000-000000000001';
const OTHER_CTX = 'cccccccc-0000-4000-8000-000000000002';
const TEAM_USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const OUTSIDER = 'aaaaaaaa-0000-4000-8000-000000000002';
const HELD_GROUP = 'bbbbbbbb-0000-4000-8000-000000000001';
const OUTSIDER_GROUP = 'bbbbbbbb-0000-4000-8000-000000000002';
const APP_HOLDER = 'aaaaaaaa-0000-4000-8000-000000000003';

// Rows per statement: the principal statement knows TEAM_USER, the resource
// statement knows HELD_GROUP (held). Everything else is name-only.
function fakePool() {
  const query = vi.fn(async (sql, [, ids]) => {
    const known = sql === TIER_SQL.principal ? { [TEAM_USER]: 'team', [APP_HOLDER]: 'holder' }
      : sql === TIER_SQL.resource ? { [HELD_GROUP]: 'held' } : {};
    return { rows: ids.filter(id => known[id]).map(id => ({ id, tier: known[id] })) };
  });
  return { query };
}

let pool;
let cache;
const make = (contextIds = [CTX], opts = {}) => createOwnerAccess(contextIds, { getPool: async () => pool, cache, ...opts });

beforeEach(() => {
  pool = fakePool();
  cache = createLru(100);
});

describe('normaliseKind', () => {
  it.each([
    ['user', 'principal'], ['principal', 'principal'], ['identity', 'identity'],
    ['group', 'resource'], ['access-package', 'resource'], ['business-role', 'resource'], ['resource', 'resource'],
    ['context', 'context'], ['member', 'member'],
  ])('%s → %s', (input, out) => {
    expect(normaliseKind(input)).toBe(out);
  });

  it.each([['leaf'], [null], [undefined], ['toString'], ['constructor']])('%s → null', (input) => {
    expect(normaliseKind(input)).toBeNull();
  });
});

describe('the tiers', () => {
  it('a team member opens, an outsider does not — through the same batch', async () => {
    const access = make();
    expect(await access.canOpen('user', TEAM_USER)).toBe(true);
    expect(await access.canOpen('user', OUTSIDER)).toBe(false);
    expect([...(await access.accessibleIds('principal', [TEAM_USER, OUTSIDER]))]).toEqual([TEAM_USER]);
  });

  it('a resource the team holds opens as held; one held only by outsiders does not', async () => {
    const access = make();
    expect(await access.tierOf('group', HELD_GROUP)).toBe('held');
    expect(await access.tierOf('resource', OUTSIDER_GROUP)).toBeNull();
  });

  it('a holder of an application resource opens, as a holder', async () => {
    const access = make();
    expect(await access.tierOf('user', APP_HOLDER)).toBe('holder');
    expect(await access.canOpen('principal', APP_HOLDER)).toBe(true);
    expect([...(await access.accessibleIds('user', [APP_HOLDER, OUTSIDER, TEAM_USER]))].sort()).toEqual([TEAM_USER, APP_HOLDER].sort());
  });

  it('a principal id is not looked up as a resource (kinds never mix)', async () => {
    const access = make();
    expect(await access.canOpen('resource', TEAM_USER)).toBe(false);
    expect(await access.canOpen('user', HELD_GROUP)).toBe(false);
  });

  it('a context opens when it is in scope, matched case-insensitively, without a query', async () => {
    const access = make([CTX.toUpperCase()]);
    expect(await access.canOpen('context', CTX)).toBe(true);
    expect(await access.canOpen('context', OTHER_CTX)).toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('an unknown kind, or a malformed id, is never openable and never queried', async () => {
    const access = make();
    expect(await access.canOpen('leaf', TEAM_USER)).toBe(false);
    expect(await access.canOpen('user', 'not-a-uuid')).toBe(false);
    expect(await access.canOpen('user', undefined)).toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('accepts an upper-cased id and answers for its lower-cased form', async () => {
    const access = make();
    expect(await access.canOpen('user', TEAM_USER.toUpperCase())).toBe(true);
  });

  it('exposes the scope it was built for, lower-cased', () => {
    expect([...make([CTX.toUpperCase()]).contextIds]).toEqual([CTX]);
  });
});

describe('caching', () => {
  it('asks the database once per id for one access object — a name-only answer is remembered too', async () => {
    const access = make();
    await access.canOpen('user', OUTSIDER);
    await access.canOpen('user', OUTSIDER);
    await access.accessibleIds('user', [OUTSIDER, TEAM_USER]);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][1][1]).toEqual([TEAM_USER]);
  });

  it('a second request of the same owner reuses the answer within the TTL, and asks again after it', async () => {
    let t = 1_000;
    const now = () => t;
    await make([CTX], { now }).canOpen('user', TEAM_USER);
    t += CACHE_TTL_MS - 1;
    expect(await make([CTX], { now }).canOpen('user', TEAM_USER)).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(1);
    t += 1; // exactly the TTL: stale
    await make([CTX], { now }).canOpen('user', TEAM_USER);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('never shares an answer between owners with different scopes', async () => {
    await make([CTX]).canOpen('user', TEAM_USER);
    await make([OTHER_CTX]).canOpen('user', TEAM_USER);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][1][0]).toEqual([OTHER_CTX]);
  });

  it('the same scope listed in another order is the same owner scope', async () => {
    await make([CTX, OTHER_CTX]).canOpen('user', TEAM_USER);
    await make([OTHER_CTX, CTX]).canOpen('user', TEAM_USER);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('the shared cache can be cleared', async () => {
    const access1 = createOwnerAccess([CTX], { getPool: async () => pool });
    await access1.canOpen('user', TEAM_USER);
    clearOwnerAccessCache();
    await createOwnerAccess([CTX], { getPool: async () => pool }).canOpen('user', TEAM_USER);
    expect(pool.query).toHaveBeenCalledTimes(2);
    clearOwnerAccessCache();
  });
});
