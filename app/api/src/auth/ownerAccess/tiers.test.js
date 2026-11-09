// The tier classifier's JavaScript half: which ids reach the database, with
// which parameters, and how the rows come back. What the statements SELECT is
// proven against PostgreSQL by contract-tests/ownerAccess.contract.test.js —
// these mocks are SQL-blind.

import { describe, it, expect, vi } from 'vitest';
import { classifyTiers, cleanIds, TIER_SQL, KINDS, TEAM, HELD, HOLDER } from './tiers.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CTX = 'cccccccc-0000-4000-8000-000000000003';

const poolReturning = (rows) => ({ query: vi.fn(async () => ({ rows })) });

describe('cleanIds', () => {
  it('lower-cases, de-duplicates and keeps only uuids', () => {
    expect(cleanIds([A.toUpperCase(), A, B, 'not-a-uuid', '', null, undefined, `${A} `])).toEqual([A, B]);
  });

  it('copes with no batch at all', () => {
    expect(cleanIds(undefined)).toEqual([]);
  });
});

describe('TIER_SQL', () => {
  it('has a statement for every kind it claims, and only those', () => {
    expect(Object.keys(TIER_SQL).sort()).toEqual([...KINDS].sort());
  });

  it('labels a resource team or held, a person or account team or holder, a member team only', () => {
    expect(TIER_SQL.resource).toContain(`'${TEAM}'`);
    expect(TIER_SQL.resource).toContain(`'${HELD}'`);
    expect(TIER_SQL.resource).not.toContain(`'${HOLDER}'`);
    for (const kind of ['principal', 'identity']) {
      expect(TIER_SQL[kind]).toContain(`'${TEAM}'`);
      expect(TIER_SQL[kind]).toContain(`'${HOLDER}'`);
      expect(TIER_SQL[kind]).not.toContain(`'${HELD}'`);
    }
    expect(TIER_SQL.member).not.toMatch(/held|holder/);
  });

  it('a holder holds a resource that is a member of an in-scope context, through a live assignment', () => {
    for (const kind of ['principal', 'identity']) {
      expect(TIER_SQL[kind]).toContain(`cm."memberId" = a."resourceId" AND cm."memberType" = 'Resource'`);
      expect(TIER_SQL[kind]).toContain(`a."deletedAt" IS NULL AND a."assignmentType" IN ('Direct', 'Indirect', 'Eligible')`);
    }
  });

  it('only counts live Direct, Indirect and Eligible assignments as held', () => {
    expect(TIER_SQL.resource).toContain(`a."deletedAt" IS NULL`);
    expect(TIER_SQL.resource).toContain(`a."assignmentType" IN ('Direct', 'Indirect', 'Eligible')`);
  });
});

describe('classifyTiers', () => {
  it('sends the scope and the cleaned batch, and maps the rows by lower-cased id', async () => {
    const pool = poolReturning([{ id: A.toUpperCase(), tier: 'held' }]);
    const out = await classifyTiers(pool, new Set([CTX]), 'resource', [A, A.toUpperCase(), 'junk']);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toBe(TIER_SQL.resource);
    expect(pool.query.mock.calls[0][1]).toEqual([[CTX], [A]]);
    expect([...out]).toEqual([[A, 'held']]);
  });

  it('runs the statement of the kind asked for', async () => {
    const pool = poolReturning([]);
    await classifyTiers(pool, [CTX], 'identity', [B]);
    expect(pool.query.mock.calls[0][0]).toBe(TIER_SQL.identity);
  });

  it('does not query for an empty batch, or for an owner with no contexts', async () => {
    const pool = poolReturning([{ id: A, tier: 'team' }]);
    expect((await classifyTiers(pool, [CTX], 'principal', ['junk'])).size).toBe(0);
    expect((await classifyTiers(pool, [], 'principal', [A])).size).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('refuses a kind it has no statement for (a context is decided without SQL)', async () => {
    await expect(classifyTiers(poolReturning([]), [CTX], 'context', [A])).rejects.toThrow(/unknown owner-access kind/);
  });
});
