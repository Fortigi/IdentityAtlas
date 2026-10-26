// GET /api/contexts/:id/people's reads: the merge rules on a whole unit, paging
// across groups, the counts per filter, and a fixed number of statements however
// many members the unit has. The unit (invented names):
//   Ann    listed, a confirmed role claim, the Accountable            → current
//   Bob    listed, marked former by a decision                        → left (decided)
//   Cleo   listed, a source says she came back                        → came back
//   Dana   not listed, a proposed claim says she is in it              → not confirmed (and to decide)
//   Eve    not listed, a source says she left                         → left
//   Frank, Gina  listed, nothing said about them                      → current
import { describe, it, expect, vi } from 'vitest';
import { loadPeople } from './peopleLoad.js';
import * as store from './store.js';
import { CONTRADICTION_CONTEXT_SQL, CONTRADICTION_MEMBERS_SQL } from './contradictions.js';

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const id = (n) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const [ANN, BOB, CLEO, DANA, EVE, FRANK, GINA] = [1, 2, 3, 4, 5, 6, 7].map(id);
const context = { id: CTX, targetType: 'Principal', contextCategory: 'OrganizationalUnit' };

let n = 0;
const claim = (holder, name, over) => ({
  id: `c-${++n}`, interviewId: 'iv-1', claimKind: 'membership', attribute: 'current', value: 'x', status: 'confirmed',
  periodFrom: null, periodTo: null, periodText: null, quote: `${name} is here`, intervieweeName: 'Iris Interviewee',
  interviewedAt: '2026-10-01', createdAt: '2026-10-01T10:00:00Z', fileName: 'talk.txt', sourceKind: 'interview',
  principalId: holder, identityId: null, holderId: holder, subjectName: name, subjectDisplayName: name, ...over,
});

function unit({ extraListed = 0 } = {}) {
  const claims = [
    claim(ANN, 'Ann Example', { claimKind: 'role', attribute: 'member', value: 'Architect' }),
    claim(BOB, 'Bob Sample', { attribute: 'left', id: 'c-bob-left' }),
    claim(CLEO, 'Cleo Back', { attribute: 'rejoined' }),
    claim(DANA, 'Dana Said', { status: 'proposed', id: 'c-dana' }),
    claim(EVE, 'Eve Gone', { attribute: 'left' }),
  ];
  const listed = [
    { id: ANN, displayName: 'Ann Example' }, { id: CLEO, displayName: 'Cleo Back' },
    { id: FRANK, displayName: 'Frank Quiet' }, { id: GINA, displayName: 'Gina Quiet' },
    ...Array.from({ length: extraListed }, (_, i) => ({ id: `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`, displayName: `Zz ${i}` })),
  ];
  const holders = [
    { id: ANN, principalId: ANN, displayName: 'Ann Example', email: 'ann@example.test', listed: true },
    { id: BOB, principalId: BOB, displayName: 'Bob Sample', listed: true, overrideClaimId: 'c-bob-left', overrideSource: 'Customer list (upload)', overrideBy: null, overrideAt: '2026-10-23T10:00:00Z' },
    { id: CLEO, principalId: CLEO, displayName: 'Cleo Back', listed: true },
    { id: DANA, principalId: DANA, displayName: 'Dana Said', listed: false },
    { id: EVE, principalId: EVE, displayName: 'Eve Gone', listed: false },
  ];
  const db = {
    query: vi.fn(async (sql, params) => {
      if (sql === store.personClaimsSql('Principal')) return { rows: claims };
      if (sql.includes('FROM "ContextClaims" c') && sql.includes('ORDER BY iv."interviewedAt" DESC')) return { rows: claims };
      if (sql.includes(`r.role = 'Accountable'`)) return { rows: [] };
      if (sql === CONTRADICTION_CONTEXT_SQL) return { rows: [{ targetType: 'Principal', variant: 'synced', systemName: 'Customer list (upload)' }] };
      if (sql === CONTRADICTION_MEMBERS_SQL) return { rows: [ANN, BOB, CLEO].filter(m => params[1].includes(m)).map(memberId => ({ memberId })) };
      if (sql === store.holderRowsSql('Principal')) return { rows: holders };
      if (sql === store.ENTITLEMENT_COUNTS_SQL) {
        return { rows: [{ col: 'principalId', id: ANN, liveEntitlements: 12, linkedEntitlements: 0 }, { col: 'principalId', id: EVE, liveEntitlements: 3, linkedEntitlements: 0 }] };
      }
      if (sql === store.LINKED_RESOURCE_COUNT_SQL) return { rows: [{ n: 0 }] };
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    }),
  };
  const loadMembers = vi.fn(async (_id, _type, { limit, offset, search }) => {
    const all = listed.filter(m => !search || m.displayName.toLowerCase().includes(search.toLowerCase()));
    return { rows: all.slice(offset, offset + limit), total: all.length, overriddenCount: 1 };
  });
  const loadRoles = vi.fn(async () => [{ role: 'Accountable', principalId: ANN }]);
  return { db, loadMembers, loadRoles };
}

const people = (deps, query, statuses = ['proposed', 'confirmed', 'edited']) => loadPeople(deps, context, query, statuses);
const brief = (r) => r.data.map(p => [p.displayName, p.status]);

describe('loadPeople — one row per person, one status', () => {
  it('current: the listed members by name first, then the not confirmed; counts for every filter', async () => {
    const r = await people(unit(), {});
    expect(brief(r)).toEqual([
      ['Ann Example', 'current'], ['Cleo Back', 'cameBack'], ['Frank Quiet', 'current'], ['Gina Quiet', 'current'], ['Dana Said', 'notConfirmed'],
    ]);
    expect(r.counts).toEqual({ current: 5, former: 2, all: 7, decide: 1 });
    expect(r).toMatchObject({ total: 5, filter: 'current', limit: 100, offset: 0, linkedResources: 0 });
  });

  it('a person appears once: Ann carries her claim, her role and what she holds; Cleo her return', async () => {
    const r = await people(unit(), {});
    const [ann, cleo, frank] = r.data;
    expect(ann).toMatchObject({ roles: ['Accountable'], role: { value: 'Architect' }, sources: ['list', 'interview'], liveEntitlements: 12, email: null });
    expect(ann.claims.map(c => c.value)).toEqual(['Architect']);
    expect(cleo.rejoined).toMatchObject({ membershipStatus: 'rejoined' });
    expect(frank).toMatchObject({ claims: [], sources: ['list'], liveEntitlements: 0, roles: [] });
  });

  it('former: left (decided) before left; the decided one still listed, with the decision', async () => {
    const r = await people(unit(), { filter: 'former' });
    expect(brief(r)).toEqual([['Bob Sample', 'leftDecided'], ['Eve Gone', 'left']]);
    expect(r.data[0]).toMatchObject({ stillListed: true, former: true, decision: { overrides: 'Customer list (upload)', claimId: 'c-bob-left' } });
    expect(r.data[1]).toMatchObject({ stillListed: false, liveEntitlements: 3 });
    expect(r.total).toBe(2);
  });

  it('decide: only the people with an open contradiction, each with its id', async () => {
    const r = await people(unit(), { filter: 'decide' });
    expect(brief(r)).toEqual([['Dana Said', 'notConfirmed']]);
    expect(r.data[0].contradictions).toEqual(['memberNotListed:c-dana']);
    expect(r.total).toBe(1);
  });

  it('all, paged across the group edge: offset 3, limit 3 → the last listed, the not confirmed, the decided former', async () => {
    const deps = unit();
    const r = await people(deps, { filter: 'all', offset: '3', limit: '3' });
    expect(brief(r)).toEqual([['Gina Quiet', 'current'], ['Dana Said', 'notConfirmed'], ['Bob Sample', 'leftDecided']]);
    expect(deps.loadMembers.mock.calls[0][2]).toMatchObject({ limit: 3, offset: 3, withTotal: true });
  });

  it('a page past the listed members reads none of them, but still counts them', async () => {
    const deps = unit();
    const r = await people(deps, { filter: 'current', offset: '4' });
    expect(brief(r)).toEqual([['Dana Said', 'notConfirmed']]);
    const formerOnly = await people(deps, { filter: 'former' });
    expect(deps.loadMembers.mock.calls[1][2]).toMatchObject({ limit: 0 });
    expect(formerOnly.counts.current).toBe(5);
  });

  it('the search narrows the members read and the people in memory alike', async () => {
    const r = await people(unit(), { filter: 'all', search: 'a' });
    // a in Ann, Dana, Frank, Gina, Sample (Bob); not in Cleo Back? "Back" has an a too.
    expect(r.data.map(p => p.displayName)).toEqual(['Ann Example', 'Cleo Back', 'Frank Quiet', 'Gina Quiet', 'Dana Said', 'Bob Sample']);
    const none = await people(unit(), { filter: 'all', search: 'eve' });
    expect(brief(none)).toEqual([['Eve Gone', 'left']]);
    expect(none.counts).toEqual({ current: 0, former: 1, all: 1, decide: 0 });
  });

  it('a reader is answered from the statuses it may see: every claim read gets them', async () => {
    const deps = unit();
    await people(deps, {}, ['confirmed', 'edited']);
    const claimReads = deps.db.query.mock.calls.filter(c => c[0].includes('"claimStatus" = ANY'));
    expect(claimReads.length).toBe(2);
    for (const [, params] of claimReads) expect(params).toContainEqual(['confirmed', 'edited']);
  });

  it('a fixed number of statements, whatever the size of the unit', async () => {
    const small = unit();
    await people(small, {});
    const big = unit({ extraListed: 300 });
    const r = await people(big, { filter: 'all' });
    expect(small.db.query).toHaveBeenCalledTimes(8);
    expect(big.db.query).toHaveBeenCalledTimes(8);
    expect([small.loadMembers, big.loadMembers, small.loadRoles, big.loadRoles].map(f => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(r.data).toHaveLength(100);
    expect(r.counts.all).toBe(307);
  });
});

describe('loadPeople — a context whose members are not people', () => {
  it('reads no members and no holders; what the sources say decides the status', async () => {
    const claims = [
      claim(null, 'Ann Example', { principalId: ANN, holderId: null }),
      claim(null, 'Eve Gone', { principalId: EVE, holderId: null, attribute: 'left' }),
    ];
    const db = {
      query: vi.fn(async (sql) => {
        if (sql === store.personClaimsSql('Resource')) return { rows: claims };
        if (sql === CONTRADICTION_CONTEXT_SQL) return { rows: [{ targetType: 'Resource', variant: 'manual' }] };
        if (sql === store.LINKED_RESOURCE_COUNT_SQL) return { rows: [{ n: 4 }] };
        if (sql === store.ENTITLEMENT_COUNTS_SQL) return { rows: [{ col: 'principalId', id: ANN, liveEntitlements: 2, linkedEntitlements: 1 }] };
        return { rows: [] };
      }),
    };
    const loadMembers = vi.fn();
    const r = await loadPeople({ db, loadMembers, loadRoles: async () => [] }, { id: CTX, targetType: 'Resource' }, { filter: 'all' }, ['confirmed']);
    expect(brief(r)).toEqual([['Ann Example', 'current'], ['Eve Gone', 'left']]);
    expect(r.data[0]).toMatchObject({ liveEntitlements: 2, linkedEntitlements: 1, sources: ['interview'] });
    expect(r.counts).toEqual({ current: 1, former: 1, all: 2, decide: 0 });
    expect(loadMembers).not.toHaveBeenCalled();
    expect(db.query.mock.calls.map(c => c[0])).not.toContain(store.holderRowsSql('Principal'));
  });
});
