import { describe, it, expect, vi } from 'vitest';
import {
  findImprovements, recentSince, handedOutByHand, NOT_A_PERMISSION,
  HOLDERS_SQL, PERMISSION_CANDIDATES_SQL, RULE_POPULATION_SQL, LAST_REVIEW_SQL,
} from './roleImprovements.js';
import { ROLE_CONTROL_SQL } from './businessRoleAccessModel.js';

const ROLE = 'dddddddd-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-28T12:00:00Z');
const user = (id, department = 'Development', extra = {}) =>
  ({ id, systemId: 1, principalType: 'User', department, jobTitle: 'Engineer', companyName: 'Contoso', automatic: false, ...extra });
const holders = (n) => Array.from({ length: n }, (_, i) => user(`u${i}`));

// A pool that answers each statement with its own rows and records what it was asked.
function fakePool({ holderRows = [], control = [], last = [], candidates = [], population = [] } = {}) {
  const answers = new Map([
    [HOLDERS_SQL, holderRows], [ROLE_CONTROL_SQL, control], [LAST_REVIEW_SQL, last],
    [PERMISSION_CANDIDATES_SQL, candidates], [RULE_POPULATION_SQL, population],
  ]);
  return {
    query: vi.fn(async (sql) => {
      if (!answers.has(sql)) throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
      return { rows: answers.get(sql) };
    }),
  };
}
const asked = (pool, sql) => pool.query.mock.calls.filter(([s]) => s === sql).map(([, params]) => params);
const manual = [{ resourceId: ROLE, policyCount: 1, inRequest: true, inRule: false }];
const byRule = [{ resourceId: ROLE, policyCount: 1, inRule: true, outRule: true }];

describe('recentSince', () => {
  it('is the last review, else 90 days ago', () => {
    expect(recentSince('2026-10-01T10:00:00Z', NOW).toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(recentSince(null, NOW).toISOString()).toBe('2026-08-30T12:00:00.000Z');
    expect(recentSince('not a date', NOW).toISOString()).toBe('2026-08-30T12:00:00.000Z');
  });
});

describe('handedOutByHand', () => {
  it('is no rule in the policies and nobody holding it by one', () => {
    expect(handedOutByHand(['Request'], [user('a')])).toBe(true);
    expect(handedOutByHand(['Unknown'], [])).toBe(true);
    expect(handedOutByHand(['Request', 'Rule'], [user('a')])).toBe(false);
    expect(handedOutByHand(['Request'], [user('a'), user('b', 'X', { automatic: true })])).toBe(false);
  });
});

describe('findImprovements', () => {
  it('suggests an exact permission and an exact rule for a role handed out by hand', async () => {
    const pool = fakePool({
      holderRows: holders(6), control: manual,
      candidates: [{ id: 'G1', displayName: 'SG-Data', resourceType: 'Group', createdDateTime: null, membersHolding: 6, othersHolding: 0 }],
      population: holders(6),
    });
    const out = await findImprovements(ROLE, { pool, now: NOW });
    expect(out.suggestions.map(s => [s.kind, s.key, s.confidence])).toEqual([
      ['addPermission', 'permission:g1', 100],
      ['automaticRule', 'rule:department=Development', 100],
    ]);
    expect(out).toMatchObject({ declinedBefore: 0, handedOutByHand: true, holderCount: 6, since: '2026-08-30T12:00:00.000Z' });
    expect(out.thresholds).toEqual({ confidence: 95, holders: 5, recentDays: 90 });
    // Every holder but at most 5% must have it: 6 × 0.95 rounds up to 6.
    expect(asked(pool, PERMISSION_CANDIDATES_SQL)).toEqual([[ROLE, 6, NOT_A_PERMISSION]]);
    expect(asked(pool, RULE_POPULATION_SQL)).toEqual([[[1], 'Development', 'Engineer', 'Contoso']]);
  });

  it('suggests no rule for a role a rule hands out already', async () => {
    const pool = fakePool({ holderRows: holders(6), control: byRule, population: holders(6) });
    const out = await findImprovements(ROLE, { pool, now: NOW });
    expect(out).toMatchObject({ suggestions: [], handedOutByHand: false });
    expect(asked(pool, RULE_POPULATION_SQL)).toEqual([]);
  });

  it('asks nothing more for a role with too few holders, and says so honestly with an empty list', async () => {
    const pool = fakePool({ holderRows: holders(4), control: manual });
    const out = await findImprovements(ROLE, { pool, now: NOW });
    expect(out.suggestions).toEqual([]);
    expect(out.holderCount).toBe(4);
    expect(asked(pool, PERMISSION_CANDIDATES_SQL)).toEqual([]);
  });

  it('builds a rule only on user accounts, from the systems they are in, with NULL for what they do not share', async () => {
    const rows = [...holders(5).map((h, i) => ({ ...h, systemId: i < 3 ? 1 : 2, jobTitle: `T${i}` })), user('sp', 'Development', { principalType: 'ServicePrincipal', systemId: 9 })];
    const pool = fakePool({ holderRows: rows, control: manual, population: [] });
    await findImprovements(ROLE, { pool, now: NOW });
    expect(asked(pool, RULE_POPULATION_SQL)).toEqual([[[1, 2], 'Development', null, 'Contoso']]);
  });

  it('reads no population when the users share nothing a rule could use', async () => {
    const rows = holders(5).map((h, i) => ({ ...h, department: `D${i}`, jobTitle: `T${i}`, companyName: `C${i}` }));
    const pool = fakePool({ holderRows: rows, control: manual });
    await findImprovements(ROLE, { pool, now: NOW });
    expect(asked(pool, RULE_POPULATION_SQL)).toEqual([]);
  });

  it('needs MIN_HOLDERS user accounts for a rule, not just holders', async () => {
    const rows = [...holders(4), user('sp', 'Development', { principalType: 'ServicePrincipal' })];
    const pool = fakePool({ holderRows: rows, control: manual });
    await findImprovements(ROLE, { pool, now: NOW });
    expect(asked(pool, RULE_POPULATION_SQL)).toEqual([]);
  });

  it('counts "recent" from the last review, and leaves out what it declined', async () => {
    const pool = fakePool({
      holderRows: holders(20), control: byRule,
      last: [{ reviewedAt: '2026-10-01T00:00:00Z', suggestions: [{ key: 'permission:old', decision: 'decline' }, { key: 'permission:kept', decision: 'adopt' }, { decision: 'decline' }] }],
      candidates: [
        { id: 'new', displayName: 'SG-New', createdDateTime: '2026-10-02T00:00:00Z', membersHolding: 19, othersHolding: 0 },
        { id: 'before', displayName: 'SG-Before', createdDateTime: '2026-09-30T00:00:00Z', membersHolding: 19, othersHolding: 0 },
        { id: 'old', displayName: 'SG-Old', createdDateTime: null, membersHolding: 20, othersHolding: 0 },
        { id: 'kept', displayName: 'SG-Kept', createdDateTime: null, membersHolding: 20, othersHolding: 0 },
      ],
    });
    const out = await findImprovements(ROLE, { pool, now: NOW });
    expect(out.since).toBe('2026-10-01T00:00:00.000Z');
    expect(out.suggestions.map(s => s.key)).toEqual(['permission:kept', 'permission:new']);
    expect(out.declinedBefore).toBe(1);
    expect(asked(pool, PERMISSION_CANDIDATES_SQL)[0][1]).toBe(19);
  });

  it('copes with a role nobody reviewed and that has no policies', async () => {
    const pool = fakePool({ holderRows: [], control: [], last: [] });
    expect(await findImprovements(ROLE, { pool, now: NOW })).toMatchObject({ suggestions: [], handedOutByHand: true, holderCount: 0 });
  });
});

describe('the statements', () => {
  it('count holders as the role\'s own holder count does: live, delivered, live accounts', () => {
    for (const sql of [HOLDERS_SQL, PERMISSION_CANDIDATES_SQL]) {
      expect(sql).toContain(`a."deletedAt" IS NULL AND (LOWER(a.state) = 'delivered' OR a.state IS NULL)`);
      expect(sql).toContain('p."deletedAt" IS NULL');
    }
  });

  it('take a permission the holders hold themselves, and count others holding it in any way', () => {
    expect(PERMISSION_CANDIDATES_SQL).toContain(`a."assignmentType" = 'Direct'`);
    expect(PERMISSION_CANDIDATES_SQL).toContain('HAVING COUNT(DISTINCT a."principalId") >= $2');
    expect(PERMISSION_CANDIDATES_SQL).toContain('NOT EXISTS (SELECT 1 FROM holders h WHERE h.id = o."principalId")');
    expect(PERMISSION_CANDIDATES_SQL).not.toMatch(/o\."assignmentType"/);
  });

  it('leave out the role itself, what is no permission, ownership, and what any business role contains', () => {
    expect(PERMISSION_CANDIDATES_SQL).toContain('a."resourceId" <> $1');
    expect(PERMISSION_CANDIDATES_SQL).toContain(`<> ALL($3::text[])`);
    expect(PERMISSION_CANDIDATES_SQL).toContain(`NOT LIKE '%Ownership'`);
    expect(PERMISSION_CANDIDATES_SQL).toContain(`COALESCE(r."extendedAttributes"->>'groupTypes', '') NOT ILIKE '%DynamicMembership%'`);
    expect(PERMISSION_CANDIDATES_SQL).toContain(`br."resourceType" = 'BusinessRole'`);
    expect(PERMISSION_CANDIDATES_SQL).toContain(`rr."relationshipType" = 'Contains'`);
    expect(NOT_A_PERMISSION).toEqual(['BusinessRole', 'Application', 'AppRegistration', 'DelegatedPermission', 'ApplicationPermission']);
  });

  it('read a rule\'s population from live user accounts in the holders\' systems', () => {
    expect(RULE_POPULATION_SQL).toContain(`p."principalType" = 'User'`);
    expect(RULE_POPULATION_SQL).toContain('p."systemId" = ANY($1::int[])');
    expect(RULE_POPULATION_SQL).toContain('btrim(p.department) = $2 OR btrim(p."jobTitle") = $3 OR btrim(p."companyName") = $4');
  });

  it('read only the newest review, and only its improvements step', () => {
    expect(LAST_REVIEW_SQL).toContain(`s.step = 'improvements'`);
    expect(LAST_REVIEW_SQL).toContain('ORDER BY r."reviewedAt" DESC, r.id');
    expect(LAST_REVIEW_SQL).toContain('LIMIT 1');
  });
});
