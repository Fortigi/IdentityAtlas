// What interviews say about the people in the members lists: role, left, previous members.
import { describe, it, expect, vi } from 'vitest';
import {
  personRole, latestMembership, leftOf, factsByMember, withInterviewMemberFacts, previousMembersOf, loadPreviousMembers, compareRoles,
} from './memberFacts.js';
import { MEMBER_CLAIMS_SQL, PEOPLE_CLAIMS_SQL, ENTITLEMENT_COUNTS_SQL, LINKED_RESOURCE_COUNT_SQL, PERSON_CLAIM_KINDS } from './store.js';

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const PIET = 'aaaaaaaa-0000-4000-8000-000000000001';
const JAN = 'aaaaaaaa-0000-4000-8000-000000000002';
const KAREL = 'aaaaaaaa-0000-4000-8000-000000000003';
const PERSON = 'bbbbbbbb-0000-4000-8000-000000000001';

let n = 0;
const claim = (over) => ({
  id: `c-${++n}`, interviewId: 'iv-1', claimKind: 'roleHistory', attribute: 'member', value: 'x', status: 'confirmed',
  periodFrom: null, periodTo: null, periodText: null, quote: null, intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01',
  createdAt: '2026-10-01T10:00:00Z', ...over,
});

describe('personRole', () => {
  it('a role said in the present beats a dated history; history is oldest first', () => {
    const junior = claim({ value: 'junior', periodFrom: '2015-01-01', periodTo: '2017-12-31' });
    const lead = claim({ claimKind: 'role', value: 'Lead architect' });
    const mid = claim({ value: 'developer', periodFrom: '2018-01-01', periodTo: '2020-12-31' });
    const r = personRole([lead, junior, mid]);
    expect(r.value).toBe('Lead architect');
    expect(r.history.map(h => h.value)).toEqual(['junior', 'developer', 'Lead architect']);
  });

  it('"now" in the period counts as current; an open start runs on; undated history is the past', () => {
    expect(personRole([claim({ value: 'architect', periodText: 'now' }), claim({ value: 'manager', periodTo: '2025-06-30' })]).value).toBe('architect');
    expect(personRole([claim({ value: 'early', periodText: 'in the early years' }), claim({ value: 'since', periodFrom: '2021-01-01' })]).value).toBe('since');
    expect(personRole([claim({ value: 'a', periodFrom: '2019-01-01' }), claim({ value: 'b', periodFrom: '2022-01-01' })]).value).toBe('b');
  });

  it('the same period: the later interview, then the later claim', () => {
    expect(personRole([claim({ value: 'old', interviewedAt: '2026-01-01' }), claim({ value: 'new', interviewedAt: '2026-09-01' })]).value).toBe('new');
    expect(personRole([claim({ value: 'first', createdAt: '2026-10-01T09:00:00Z' }), claim({ value: 'second', createdAt: '2026-10-01T11:00:00Z' })]).value).toBe('second');
  });

  it('"not the owner" is no role, and neither is a membership', () => {
    expect(personRole([claim({ claimKind: 'role', attribute: 'notOwner', value: 'not the owner' }), claim({ claimKind: 'membership', attribute: 'left' })])).toBeNull();
  });

  it('compareRoles orders an end date before an open end', () => {
    const ended = claim({ periodTo: '2030-01-01' });
    const open = claim({ periodFrom: '2001-01-01' });
    expect(compareRoles(ended, open)).toBe(-1);
    expect(compareRoles(open, ended)).toBe(1);
  });
});

describe('latestMembership and leftOf', () => {
  it('the newest interview wins, and only former / left count as gone', () => {
    const left = claim({ claimKind: 'membership', attribute: 'left', interviewedAt: '2026-03-01', periodText: 'last spring' });
    const back = claim({ claimKind: 'membership', attribute: 'joined', interviewedAt: '2026-09-01' });
    expect(latestMembership([left, back]).membershipStatus).toBe('joined');
    expect(leftOf([left, back])).toBeNull();
    expect(leftOf([left])).toMatchObject({ claimId: left.id, membershipStatus: 'left', periodText: 'last spring', intervieweeName: 'Anna Voorbeeld' });
    expect(leftOf([claim({ claimKind: 'membership', attribute: 'former' })]).membershipStatus).toBe('former');
    expect(leftOf([claim({ claimKind: 'membership', attribute: 'current' })])).toBeNull();
    expect(latestMembership([claim({})])).toBeNull();
  });

  it('within one interview, the later claim wins', () => {
    const a = claim({ claimKind: 'membership', attribute: 'current', createdAt: '2026-10-01T09:00:00Z' });
    const b = claim({ claimKind: 'membership', attribute: 'left', createdAt: '2026-10-01T09:30:00Z' });
    expect(leftOf([b, a]).claimId).toBe(b.id);
  });
});

describe('factsByMember', () => {
  it('one entry per member, each from their own claims only', () => {
    const facts = factsByMember([
      claim({ memberId: PIET, claimKind: 'role', value: 'lead' }),
      claim({ memberId: JAN, claimKind: 'membership', attribute: 'left' }),
    ]);
    expect([...facts.keys()]).toEqual([PIET, JAN]);
    expect(facts.get(PIET)).toMatchObject({ role: { value: 'lead' }, left: null });
    expect(facts.get(JAN)).toMatchObject({ role: null, left: { membershipStatus: 'left' } });
  });
});

describe('withInterviewMemberFacts', () => {
  it('one statement for the whole page, with the page ids (once each), the person kinds and the statuses', async () => {
    const db = { query: vi.fn(async () => ({ rows: [claim({ memberId: JAN, claimKind: 'membership', attribute: 'left' })] })) };
    const rows = await withInterviewMemberFacts(db, CTX, 'Principal', [{ id: PIET }, { id: JAN }, { id: PIET }], ['confirmed', 'edited']);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]).toEqual([MEMBER_CLAIMS_SQL.Principal, [CTX, [PIET, JAN], PERSON_CLAIM_KINDS, ['confirmed', 'edited']]]);
    expect(rows.map(r => [r.id, r.interview.left?.membershipStatus ?? null])).toEqual([[PIET, null], [JAN, 'left'], [PIET, null]]);
  });

  it('asks nothing for a page of resources or an empty page', async () => {
    const db = { query: vi.fn() };
    expect(await withInterviewMemberFacts(db, CTX, 'Resource', [{ id: 'r' }], ['confirmed'])).toEqual([{ id: 'r' }]);
    expect(await withInterviewMemberFacts(db, CTX, 'Principal', [], ['confirmed'])).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('a person-context reads claims about the person or one of their accounts', () => {
    expect(MEMBER_CLAIMS_SQL.Identity).toMatch(/LEFT JOIN "IdentityMembers" im ON im."principalId" = c."principalId" AND im."identityId" = ANY\(\$2::uuid\[\]\)/);
    expect(MEMBER_CLAIMS_SQL.Identity).toMatch(/COALESCE\(c."identityId", im."identityId"\) AS "memberId"/);
  });
});

describe('previousMembersOf', () => {
  const gone = (over) => claim({ claimKind: 'membership', attribute: 'former', isMember: false, ...over });

  it('people whose latest membership says they left and who are not members now, by name, with their role', () => {
    const out = previousMembersOf([
      gone({ principalId: JAN, subjectDisplayName: 'Jan Smit', subjectName: 'Jan' }),
      claim({ principalId: JAN, subjectDisplayName: 'Jan Smit', value: 'junior', periodText: 'early years' }),
      gone({ principalId: PIET, subjectDisplayName: 'Piet de Vries', isMember: true }),
      gone({ subjectName: 'Karel  Kiezer' }),
      claim({ subjectName: 'karel kiezer', claimKind: 'membership', attribute: 'left', interviewedAt: '2026-11-01', isMember: false }),
      gone({ identityId: PERSON, subjectDisplayName: 'Anna Ander', accountDeleted: false }),
      claim({ principalId: KAREL, subjectDisplayName: 'Bram Blijft', claimKind: 'membership', attribute: 'current' }),
    ]);
    expect(out.map(p => [p.key, p.displayName, p.left.membershipStatus, p.role?.value ?? null])).toEqual([
      [`identityId:${PERSON}`, 'Anna Ander', 'former', null],
      [`principalId:${JAN}`, 'Jan Smit', 'former', 'junior'],
      ['name:karel kiezer', 'Karel  Kiezer', 'left', null],
    ]);
  });
});

describe('loadPreviousMembers', () => {
  function fakeDb({ people, counts = [], linked = 0 }) {
    return {
      query: vi.fn(async (sql) => {
        if (sql === PEOPLE_CLAIMS_SQL) return { rows: people };
        if (sql === ENTITLEMENT_COUNTS_SQL) return { rows: counts };
        if (sql === LINKED_RESOURCE_COUNT_SQL) return { rows: [{ n: linked }] };
        throw new Error('unexpected SQL');
      }),
    };
  }
  const gone = (over) => claim({ claimKind: 'membership', attribute: 'left', isMember: false, ...over });

  it('three statements in all: the claims, then the counts of every matched person at once', async () => {
    const db = fakeDb({
      people: [gone({ principalId: JAN, subjectDisplayName: 'Jan Smit' }), gone({ identityId: PERSON, subjectDisplayName: 'Anna Ander' }), gone({ subjectName: 'Karel' })],
      counts: [{ col: 'principalId', id: JAN, liveEntitlements: 12, linkedEntitlements: 3 }],
      linked: 40,
    });
    const out = await loadPreviousMembers(db, CTX, ['confirmed', 'edited']);
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query.mock.calls[0][1]).toEqual([CTX, PERSON_CLAIM_KINDS, ['confirmed', 'edited']]);
    expect(db.query.mock.calls.find(c => c[0] === ENTITLEMENT_COUNTS_SQL)[1]).toEqual([CTX, [JAN], [PERSON]]);
    expect(out.linkedResources).toBe(40);
    expect(out.data.map(p => [p.displayName, p.liveEntitlements, p.linkedEntitlements])).toEqual([
      ['Anna Ander', 0, 0], ['Jan Smit', 12, 3], ['Karel', null, null],
    ]);
  });

  it('without linked resources the linked count is null; nobody matched asks no counts', async () => {
    const db = fakeDb({ people: [gone({ subjectName: 'Karel' })], linked: 0 });
    const out = await loadPreviousMembers(db, CTX, ['confirmed']);
    expect(db.query.mock.calls.map(c => c[0])).not.toContain(ENTITLEMENT_COUNTS_SQL);
    expect(out).toEqual({ linkedResources: 0, data: [expect.objectContaining({ displayName: 'Karel', liveEntitlements: null, linkedEntitlements: null })] });

    const one = fakeDb({ people: [gone({ principalId: JAN, subjectDisplayName: 'Jan Smit' })], counts: [{ col: 'principalId', id: JAN, liveEntitlements: 5, linkedEntitlements: 2 }], linked: 0 });
    expect((await loadPreviousMembers(one, CTX, ['confirmed'])).data[0]).toMatchObject({ liveEntitlements: 5, linkedEntitlements: null });
  });

  it('counts live assignments only, a person\'s own and their accounts\', and the linked resources of the context or its variants', () => {
    expect(ENTITLEMENT_COUNTS_SQL.match(/ra."deletedAt" IS NULL/g)).toHaveLength(3);
    expect(ENTITLEMENT_COUNTS_SQL).toMatch(/FROM "IdentityMembers" im\s+JOIN "ResourceAssignments" ra ON ra."principalId" = im."principalId"/);
    expect(LINKED_RESOURCE_COUNT_SQL).toMatch(/"relationshipType" = 'SameUnitAs'/);
    expect(LINKED_RESOURCE_COUNT_SQL).toMatch(/x."targetType" = 'Resource'/);
  });
});
