// A member marked former by a decision: when a decision marks or clears, and the row shape.
import { describe, it, expect, vi } from 'vitest';
import {
  overrideAction, applyMemberOverride, clearClaimOverride, overriddenMemberCount,
  OVERRIDE_CONTEXT_SQL, UPSERT_OVERRIDE_SQL, DELETE_MEMBER_OVERRIDE_SQL, DELETE_CLAIM_OVERRIDE_SQL, OVERRIDDEN_MEMBER_COUNT_SQL,
} from './memberOverrides.js';
import { decisionOf, withOverride, OVERRIDE_JOIN, OVERRIDE_COLUMNS } from './overrideRows.js';

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const LED = 'aaaaaaaa-0000-4000-8000-000000000001';
const CLAIM = 'cccccccc-0000-4000-8000-000000000001';

const membership = (attribute, over = {}) => ({ id: CLAIM, contextId: CTX, claimKind: 'membership', attribute, value: attribute, principalId: LED, ...over });

describe('overrideAction', () => {
  it('marks when the interview is right that a person left: former, left, or a role claim saying so', () => {
    expect(overrideAction(membership('former'), 'confirmed')).toBe('mark');
    expect(overrideAction(membership('left'), 'confirmed')).toBe('mark');
    expect(overrideAction({ claimKind: 'roleHistory', value: 'worked on it until she left' }, 'confirmed')).toBe('mark');
    // Edited without a period: still "the interview is right".
    expect(overrideAction(membership('left'), 'edited', { value: 'left in the summer' })).toBe('mark');
  });

  it('marks nobody for "the list is right" or "both true, at different times"', () => {
    expect(overrideAction(membership('former'), 'rejected')).toBeNull();
    expect(overrideAction(membership('former'), 'edited', { periodText: 'until 2024' })).toBeNull();
    expect(overrideAction(membership('former'), 'edited', { periodTo: '2024-12-31' })).toBeNull();
    expect(overrideAction(membership('former', { periodFrom: '2020-01-01' }), 'edited', { value: 'x' })).toBeNull();
  });

  it('clears when confirmed that they are in it; ignores what is not about being in it', () => {
    for (const a of ['current', 'joined', 'rejoined']) expect(overrideAction(membership(a), 'confirmed'), a).toBe('clear');
    expect(overrideAction(membership('current'), 'rejected')).toBeNull();
    expect(overrideAction({ claimKind: 'role', attribute: 'notOwner', value: 'no longer the owner' }, 'confirmed')).toBeNull();
    expect(overrideAction({ claimKind: 'roleHistory', value: 'junior developer' }, 'confirmed')).toBeNull();
    expect(overrideAction({ claimKind: 'property', attribute: 'x', value: 'left' }, 'confirmed')).toBeNull();
    expect(overrideAction({ claimKind: 'description', value: 'everyone left' }, 'confirmed')).toBeNull();
  });
});

// A transaction client: the context row it is asked for, and every statement.
function client(context) {
  const calls = [];
  return {
    calls,
    query: vi.fn(async (sql, params) => {
      calls.push([sql, params]);
      return sql === OVERRIDE_CONTEXT_SQL ? { rows: context ? [context] : [] } : { rows: [], rowCount: 2 };
    }),
  };
}
const UNIT = { targetType: 'Principal', variant: 'synced', systemName: 'Klanten (upload)', isListed: true };
const holder = { col: 'principalId', id: LED };

describe('applyMemberOverride', () => {
  it('marks a listed member former, naming the source; asks the context with the member as a uuid', async () => {
    const c = client(UNIT);
    expect(await applyMemberOverride(c, membership('former'), { status: 'confirmed', merged: {}, holder }, 'analyst@example.test'))
      .toEqual({ overrides: 'Klanten (upload)' });
    expect(c.calls).toEqual([[OVERRIDE_CONTEXT_SQL, [CTX, LED]], [UPSERT_OVERRIDE_SQL, [CTX, LED, CLAIM, 'Klanten (upload)', 'analyst@example.test']]]);
    expect(OVERRIDE_CONTEXT_SQL).toContain('cm."memberId" = $2::uuid');
  });

  it('names a generated list after its rule, a list without a system "The source", and no user as null', async () => {
    const c = client({ ...UNIT, variant: 'generated', systemName: null });
    expect(await applyMemberOverride(c, membership('left'), { status: 'confirmed', merged: {}, holder })).toEqual({ overrides: 'The rule that derives it' });
    expect(c.calls[1][1][4]).toBeNull();
    expect((await applyMemberOverride(client({ ...UNIT, systemName: null }), membership('left'), { status: 'confirmed', merged: {}, holder })).overrides).toBe('The source');
  });

  it('marks nobody who is not listed, of another kind, unknown, or without a person', async () => {
    const decided = { status: 'confirmed', merged: {}, holder };
    for (const ctx of [{ ...UNIT, isListed: false }, { ...UNIT, targetType: 'Identity' }, { ...UNIT, targetType: 'Resource' }, null]) {
      const c = client(ctx);
      expect(await applyMemberOverride(c, membership('former'), decided)).toBeNull();
      expect(c.calls).toHaveLength(1);
    }
    const none = client(UNIT);
    expect(await applyMemberOverride(none, membership('former'), { ...decided, holder: null })).toBeNull();
    expect(none.calls).toEqual([]);
    const rejected = client(UNIT);
    expect(await applyMemberOverride(rejected, membership('former'), { ...decided, status: 'rejected' })).toBeNull();
    expect(rejected.calls).toEqual([]);
  });

  it('a person of a unit of people is keyed by identityId', async () => {
    const c = client({ ...UNIT, targetType: 'Identity' });
    expect(await applyMemberOverride(c, { ...membership('former'), principalId: null, identityId: LED }, { status: 'confirmed', merged: {}, holder: { col: 'identityId', id: LED } }))
      .toEqual({ overrides: 'Klanten (upload)' });
  });

  it('clears the mark of a person confirmed to be in it — listed or not', async () => {
    const c = client({ ...UNIT, isListed: false });
    expect(await applyMemberOverride(c, membership('rejoined'), { status: 'confirmed', merged: {}, holder })).toBeNull();
    expect(c.calls[1]).toEqual([DELETE_MEMBER_OVERRIDE_SQL, [CTX, LED]]);
  });
});

describe('clearClaimOverride / overriddenMemberCount', () => {
  it('removes the marks of one claim and says how many', async () => {
    const c = client(UNIT);
    expect(await clearClaimOverride(c, CLAIM)).toBe(2);
    expect(c.calls).toEqual([[DELETE_CLAIM_OVERRIDE_SQL, [CLAIM]]]);
    expect(await clearClaimOverride({ query: async () => ({}) }, CLAIM)).toBe(0);
  });

  it('counts the marked members the source still lists, 0 without a row', async () => {
    const db = { queryOne: vi.fn(async () => ({ n: 3 })) };
    expect(await overriddenMemberCount(db, CTX)).toBe(3);
    expect(db.queryOne).toHaveBeenCalledWith(OVERRIDDEN_MEMBER_COUNT_SQL, [CTX]);
    expect(await overriddenMemberCount({ queryOne: async () => null }, CTX)).toBe(0);
    expect(OVERRIDDEN_MEMBER_COUNT_SQL).toContain('JOIN "ContextMembers" cm ON cm."contextId" = o."contextId" AND cm."memberId" = o."memberId"');
  });
});

describe('overrideRows', () => {
  const marked = { id: LED, displayName: 'Led Ledeboer', overrideClaimId: CLAIM, overrideSource: 'Klanten (upload)', overrideBy: 'analyst@example.test', overrideAt: '2026-10-23T10:00:00Z' };

  it('reads the decision off a row, null without one', () => {
    expect(decisionOf(marked)).toEqual({ by: 'analyst@example.test', at: '2026-10-23T10:00:00Z', overrides: 'Klanten (upload)', claimId: CLAIM });
    expect(decisionOf({ ...marked, overrideBy: undefined, overrideAt: undefined })).toMatchObject({ by: null, at: null });
    expect(decisionOf({ id: LED })).toBeNull();
    expect(decisionOf(null)).toBeNull();
  });

  it('puts the decision in place of the columns', () => {
    expect(withOverride(marked)).toEqual({ id: LED, displayName: 'Led Ledeboer', overridden: decisionOf(marked) });
    expect(withOverride({ id: LED, overrideClaimId: null })).toEqual({ id: LED, overridden: null });
    expect(OVERRIDE_JOIN).toContain('o."contextId" = cm."contextId" AND o."memberId" = cm."memberId"');
    expect(OVERRIDE_COLUMNS.match(/AS "(\w+)"/g)).toHaveLength(4);
  });
});
