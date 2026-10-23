import { describe, it, expect, vi } from 'vitest';
import {
  CHANGE_KINDS, CHANGE_STATUSES, REASONS, ChangeRequestError,
  summaryFor, targetOf, parseFilters, raiseForOverride, withdrawForMember, withdrawForClaim, reconcile, listChangeRequests,
  RAISE_CONTEXT_SQL, FIND_OPEN_SQL, UPDATE_OPEN_SQL, INSERT_SQL, WITHDRAW_MEMBER_SQL, WITHDRAW_CLAIM_SQL, RESOLVE_SQL, LIST_SQL, COUNTS_SQL,
} from './changeRequests.js';

const CTX = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const CLAIM = '33333333-3333-4333-8333-333333333333';
const OVERRIDE = '44444444-4444-4444-8444-444444444444';

// A fake client answering by statement; records every call.
function fakeClient(answers) {
  return {
    query: vi.fn(async (sql) => {
      const a = answers.find(([s]) => s === sql);
      return a ? a[1] : { rows: [], rowCount: 0 };
    }),
  };
}

const SYNCED = { displayName: 'Klanten', variant: 'synced', scopeSystemId: 7, systemName: 'Klanten (upload)', memberName: 'Led' };

describe('summaryFor', () => {
  it('names the member, the unit and the change for every kind', () => {
    expect(summaryFor({ changeKind: 'RelationshipRemove', memberName: 'Led', contextName: 'Klanten' })).toBe('Remove Led from Klanten');
    expect(summaryFor({ changeKind: 'RelationshipAdd', memberName: 'Klaas', contextName: 'Payroll' })).toBe('Add Klaas to Payroll');
    expect(summaryFor({ changeKind: 'EntityCreate', contextName: 'Team Noord' })).toBe('Create Team Noord');
    expect(summaryFor({ changeKind: 'EntityDelete', contextName: 'Team Zuid' })).toBe('Delete Team Zuid');
    expect(summaryFor({ changeKind: 'AttributeUpdate', contextName: 'Payroll', attribute: 'owner', expectedValue: 'Klaas' }))
      .toBe('Set owner of Payroll to Klaas');
  });

  it('reads without names, and says an empty expected value is empty', () => {
    expect(summaryFor({ changeKind: 'RelationshipRemove' })).toBe('Remove the member from the unit');
    expect(summaryFor({ changeKind: 'AttributeUpdate' })).toBe('Set the attribute of the unit to (empty)');
    expect(summaryFor({ changeKind: 'AttributeUpdate', attribute: 'tier', expectedValue: '' })).toBe('Set tier of the unit to (empty)');
  });

  it('refuses a kind outside the list', () => {
    expect(() => summaryFor({ changeKind: 'Rename' })).toThrow(ChangeRequestError);
    expect(CHANGE_KINDS).not.toContain('Rename');
  });
});

describe('targetOf', () => {
  it('is the synced context\'s system, by its name', () => {
    expect(targetOf(SYNCED)).toEqual({ systemId: 7, name: 'Klanten (upload)' });
  });

  it('falls back to the system id when the system has no name', () => {
    expect(targetOf({ variant: 'synced', scopeSystemId: 9, systemName: null })).toEqual({ systemId: 9, name: 'System 9' });
  });

  it('is null for a unit Identity Atlas owns, a rule\'s output, or a synced unit without a system', () => {
    expect(targetOf({ ...SYNCED, variant: 'manual' })).toBeNull();
    expect(targetOf({ ...SYNCED, variant: 'generated' })).toBeNull();
    expect(targetOf({ ...SYNCED, scopeSystemId: null })).toBeNull();
    expect(targetOf(undefined)).toBeNull();
  });
});

describe('parseFilters', () => {
  it('passes every filter through, checked', () => {
    expect(parseFilters({ status: 'resolved', systemId: '12', contextId: CTX })).toEqual({ status: 'resolved', systemId: 12, contextId: CTX });
  });

  it('has no filter when none is asked', () => {
    expect(parseFilters()).toEqual({ status: null, systemId: null, contextId: null });
    expect(parseFilters({ status: '', systemId: '', contextId: '' })).toEqual({ status: null, systemId: null, contextId: null });
  });

  it.each([
    [{ status: 'sent' }, /status must be one of open, resolved, withdrawn/],
    [{ systemId: '0' }, /positive integer/],
    [{ systemId: '1.5' }, /positive integer/],
    [{ systemId: 'abc' }, /positive integer/],
    [{ contextId: 'not-a-uuid' }, /Invalid contextId/],
  ])('refuses %j with a 400', (q, msg) => {
    try { parseFilters(q); throw new Error('no throw'); } catch (err) {
      expect(err).toBeInstanceOf(ChangeRequestError);
      expect(err.status).toBe(400);
      expect(err.message).toMatch(msg);
    }
  });
});

describe('raiseForOverride', () => {
  it('inserts a RelationshipRemove for the synced unit\'s system, with the names as they are now', async () => {
    const row = { id: 'r1' };
    const client = fakeClient([[RAISE_CONTEXT_SQL, { rows: [SYNCED] }], [INSERT_SQL, { rows: [row] }]]);
    const out = await raiseForOverride(client, { contextId: CTX, memberId: MEMBER, claimId: CLAIM, overrideId: OVERRIDE }, 'wim@example.org');
    expect(out).toBe(row);
    expect(client.query).toHaveBeenNthCalledWith(1, RAISE_CONTEXT_SQL, [CTX, MEMBER]);
    expect(client.query).toHaveBeenNthCalledWith(2, FIND_OPEN_SQL, ['RelationshipRemove', 7, CTX, MEMBER]);
    expect(client.query).toHaveBeenNthCalledWith(3, INSERT_SQL,
      ['RelationshipRemove', 7, 'Klanten (upload)', CTX, 'Klanten', MEMBER, 'Led', 'Remove Led from Klanten', CLAIM, OVERRIDE, 'wim@example.org']);
  });

  it('updates the open request when the same change is decided again, and adds none', async () => {
    const client = fakeClient([
      [RAISE_CONTEXT_SQL, { rows: [{ ...SYNCED, memberName: null }] }],
      [FIND_OPEN_SQL, { rows: [{ id: 'open-1' }] }],
      [UPDATE_OPEN_SQL, { rows: [{ id: 'open-1' }] }],
    ]);
    const out = await raiseForOverride(client, { contextId: CTX, memberId: MEMBER, claimId: CLAIM }, undefined);
    expect(out).toEqual({ id: 'open-1' });
    expect(client.query).toHaveBeenLastCalledWith(UPDATE_OPEN_SQL,
      ['open-1', CLAIM, null, null, 'Klanten (upload)', 'Klanten', null, 'Remove the member from Klanten']);
    expect(client.query.mock.calls.map(c => c[0])).not.toContain(INSERT_SQL);
  });

  it('raises nothing for a unit kept by hand, and writes nothing', async () => {
    const client = fakeClient([[RAISE_CONTEXT_SQL, { rows: [{ ...SYNCED, variant: 'manual' }] }]]);
    expect(await raiseForOverride(client, { contextId: CTX, memberId: MEMBER, claimId: CLAIM }, 'x')).toBeNull();
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('raises nothing when the context is gone', async () => {
    const client = fakeClient([]);
    expect(await raiseForOverride(client, { contextId: CTX, memberId: MEMBER, claimId: CLAIM }, 'x')).toBeNull();
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('looks the member up by the kind the context holds', () => {
    expect(RAISE_CONTEXT_SQL).toMatch(/ctx\."targetType" = 'Principal' AND p\.id = \$2/);
    expect(RAISE_CONTEXT_SQL).toMatch(/ctx\."targetType" = 'Identity' AND i\.id = \$2/);
  });
});

describe('withdraw', () => {
  it('withdraws the open requests about a member, with the reason, and counts them', async () => {
    const client = fakeClient([[WITHDRAW_MEMBER_SQL, { rowCount: 2 }]]);
    expect(await withdrawForMember(client, CTX, MEMBER)).toBe(2);
    expect(client.query).toHaveBeenCalledWith(WITHDRAW_MEMBER_SQL, [CTX, MEMBER, REASONS.backInUnit]);
    expect(await withdrawForMember(client, CTX, MEMBER, 'other')).toBe(2);
    expect(client.query).toHaveBeenLastCalledWith(WITHDRAW_MEMBER_SQL, [CTX, MEMBER, 'other']);
  });

  it('withdraws the open requests a claim\'s decision raised, defaulting the reason to the undo', async () => {
    const client = fakeClient([[WITHDRAW_CLAIM_SQL, { rowCount: 1 }]]);
    expect(await withdrawForClaim(client, CLAIM)).toBe(1);
    expect(client.query).toHaveBeenCalledWith(WITHDRAW_CLAIM_SQL, [CLAIM, REASONS.undone]);
  });

  it('counts zero when the driver gives no rowCount', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await withdrawForClaim(client, CLAIM)).toBe(0);
    expect(await withdrawForMember(client, CTX, MEMBER)).toBe(0);
  });

  it('only ever closes open requests, as withdrawn, with a close time', () => {
    for (const sql of [WITHDRAW_MEMBER_SQL, WITHDRAW_CLAIM_SQL]) {
      expect(sql).toMatch(/SET "requestStatus" = 'withdrawn', "closedAt" = now\(\)/);
      expect(sql).toMatch(/WHERE "requestStatus" = 'open'/);
    }
  });
});

describe('reconcile and list', () => {
  it('resolves with the unit-gone and not-listed reasons, in that order', async () => {
    const db = { query: vi.fn(async () => ({ rowCount: 3 })) };
    expect(await reconcile(db)).toBe(3);
    expect(db.query).toHaveBeenCalledWith(RESOLVE_SQL, [REASONS.unitGone, REASONS.notListed]);
    expect(RESOLVE_SQL).toMatch(/CASE WHEN r\."contextId" IS NULL THEN \$1 ELSE \$2 END/);
    expect(RESOLVE_SQL).toMatch(/SET "requestStatus" = 'resolved', "closedAt" = now\(\)/);
    expect(RESOLVE_SQL).toMatch(/r\."requestStatus" = 'open' AND r\."changeKind" = 'RelationshipRemove'/);
  });

  it('reconciles before it reads, and fills a zero for every status without rows', async () => {
    const items = [{ id: 'a' }];
    const order = [];
    const db = {
      query: vi.fn(async (sql, params) => {
        order.push(sql);
        if (sql === LIST_SQL) return { rows: items };
        if (sql === COUNTS_SQL) return { rows: [{ status: 'open', n: 4 }, { status: 'resolved', n: 1 }] };
        return { rowCount: 0 };
      }),
    };
    const out = await listChangeRequests(db, { status: 'open', systemId: 7, contextId: CTX });
    expect(out).toEqual({ items, counts: { open: 4, resolved: 1, withdrawn: 0 } });
    expect(order).toEqual([RESOLVE_SQL, LIST_SQL, COUNTS_SQL]);
    expect(db.query).toHaveBeenCalledWith(LIST_SQL, ['open', 7, CTX]);
    expect(db.query).toHaveBeenCalledWith(COUNTS_SQL, [7, CTX]);
  });

  it('lists everything when no filter is given', async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const out = await listChangeRequests(db);
    expect(out.counts).toEqual({ open: 0, resolved: 0, withdrawn: 0 });
    expect(db.query).toHaveBeenCalledWith(LIST_SQL, [null, null, null]);
    expect(Object.keys(out.counts)).toEqual([...CHANGE_STATUSES]);
  });
});
