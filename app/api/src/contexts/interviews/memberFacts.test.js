// What the sources say about one person: their role, whether they left, whether they came back.
import { describe, it, expect } from 'vitest';
import { personRole, latestMembership, leftOf, compareRoles, rejoinOf, personKey } from './memberFacts.js';
import { ENTITLEMENT_COUNTS_SQL, LINKED_RESOURCE_COUNT_SQL } from './store.js';

const PIET = 'aaaaaaaa-0000-4000-8000-000000000001';
const JAN = 'aaaaaaaa-0000-4000-8000-000000000002';

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

describe('entitlement counts', () => {
  it('counts live assignments only, a person\'s own and their accounts\', and the linked resources of the context or its variants', () => {
    expect(ENTITLEMENT_COUNTS_SQL.match(/ra."deletedAt" IS NULL/g)).toHaveLength(3);
    expect(ENTITLEMENT_COUNTS_SQL).toMatch(/FROM "IdentityMembers" im\s+JOIN "ResourceAssignments" ra ON ra."principalId" = im."principalId"/);
    expect(LINKED_RESOURCE_COUNT_SQL).toMatch(/"relationshipType" = 'SameUnitAs'/);
    expect(LINKED_RESOURCE_COUNT_SQL).toMatch(/x."targetType" = 'Resource'/);
  });
});

describe('personKey', () => {
  it('the account first, then the person, else the name as said — normalised', () => {
    expect(personKey({ principalId: PIET, identityId: 'x', subjectName: 'Piet' })).toBe(`principalId:${PIET}`);
    expect(personKey({ identityId: JAN, subjectName: 'Jan' })).toBe(`identityId:${JAN}`);
    expect(personKey({ subjectName: '  Karel   Kiezer ' })).toBe('name:karel kiezer');
  });
});

describe('left from a role claim (a model that did not say membership)', () => {
  it('a roleHistory that says left, in its value or its period, flags the person as former', () => {
    const byValue = claim({ value: 'left', periodText: 'recent' });
    expect(leftOf([byValue])).toMatchObject({ claimId: byValue.id, membershipStatus: 'former', value: 'left', periodText: 'recent' });
    expect(leftOf([claim({ value: 'worked', periodText: 'inmiddels uitgestroomd' })]).membershipStatus).toBe('former');
    expect(leftOf([claim({ value: 'worked', periodText: 'for a while' })])).toBeNull();
  });

  it('the latest word wins: a later "current" membership undoes an earlier "left", and the other way round', () => {
    const leftEarly = claim({ value: 'left', interviewedAt: '2026-03-01' });
    const backLater = claim({ claimKind: 'membership', attribute: 'current', interviewedAt: '2026-09-01' });
    expect(leftOf([leftEarly, backLater])).toBeNull();
    const currentEarly = claim({ claimKind: 'membership', attribute: 'current', interviewedAt: '2026-03-01' });
    const goneLater = claim({ value: 'vertrokken', interviewedAt: '2026-09-01' });
    expect(leftOf([currentEarly, goneLater]).claimId).toBe(goneLater.id);
  });

  it('a role that does not say left is no word on membership: an earlier "left" stands', () => {
    const gone = claim({ claimKind: 'membership', attribute: 'left', interviewedAt: '2026-03-01' });
    expect(leftOf([gone, claim({ claimKind: 'role', value: 'lead', interviewedAt: '2026-09-01' })]).claimId).toBe(gone.id);
  });

});

describe('rejoined — left once, in it again', () => {
  // Mirrors the demo unit's claims (invented names): a roleHistory "junior developer"
  // with a garbled period, a roleHistory "architect within CCoE" said "now" whose
  // quote says the person is back, and a membership 'joined' from the first half.
  const QUOTE = 'Joris Jansen begon als junior en is sinds ongeveer een half jaar terug, nu als architect binnen het CCoE.';
  const joris = (over) => claim({ principalId: JAN, memberId: JAN, subjectName: 'Joris Jansen', subjectDisplayName: 'Joris Jansen', status: 'proposed', isMember: true, ...over });
  const demo = () => [
    joris({ value: 'junior developer', attribute: 'other', periodFrom: '2026-05-01', periodTo: '2026-10-23', periodText: 'sinds ongeveer een half jaar terug', quote: 'Joris Jansen begon als junior' }),
    joris({ value: 'architect within CCoE', attribute: 'other', periodFrom: '2026-10-23', periodText: 'nu', quote: QUOTE }),
    joris({ claimKind: 'membership', attribute: 'joined', value: 'joined', quote: 'Joris Jansen begon als junior' }),
  ];

  it('current role architect, rejoined with the earlier role and the quote that says it', async () => {
    const claims = demo();
    expect(personRole(claims).value).toBe('architect within CCoE');
    expect(personRole(claims).history.map(h => h.value)).toEqual(['junior developer', 'architect within CCoE']);
    expect(leftOf(claims)).toBeNull();
    const back = rejoinOf(claims);
    expect(back).toMatchObject({ membershipStatus: 'rejoined', quote: QUOTE, value: 'architect within CCoE' });
    expect(back.earlier.map(e => [e.value, e.periodText])).toEqual([['junior developer', 'sinds ongeveer een half jaar terug']]);
  });

  it('a promotion without a word for coming back is no second stint', () => {
    const promoted = [
      joris({ value: 'junior developer', periodTo: '2024-12-31', quote: 'Joris Jansen begon als junior' }),
      joris({ value: 'architect', periodText: 'nu', quote: 'Joris Jansen is nu architect.' }),
    ];
    expect(rejoinOf(promoted)).toBeNull();
  });

  it('the return word must be in the clause about the person, not about someone else', () => {
    const other = [
      joris({ value: 'junior', periodTo: '2024-12-31' }),
      joris({ value: 'architect', periodText: 'nu', quote: 'Joris Jansen is architect; Femke kwam terug als tester.' }),
    ];
    expect(rejoinOf(other)).toBeNull();
  });

  it('a membership rejoined says it without roles; a CONFIRMED present membership after an earlier confirmed "left" says it too', () => {
    expect(rejoinOf([joris({ claimKind: 'membership', attribute: 'rejoined', value: 'back' })])).toMatchObject({ earlier: [] });
    const leftThenBack = [
      joris({ claimKind: 'membership', attribute: 'left', interviewedAt: '2025-01-01', status: 'confirmed' }),
      joris({ claimKind: 'membership', attribute: 'current', interviewedAt: '2026-09-01', status: 'edited' }),
    ];
    expect(rejoinOf(leftThenBack)).toMatchObject({ membershipStatus: 'rejoined', interviewedAt: '2026-09-01' });
    // while one of them is only proposed the interviews disagree: a contradiction, not a return
    expect(rejoinOf([leftThenBack[0], { ...leftThenBack[1], status: 'proposed' }])).toBeNull();
    expect(rejoinOf([{ ...leftThenBack[0], status: 'proposed' }, leftThenBack[1]])).toBeNull();
    // the same interview saying both is a contradiction, not a return
    expect(rejoinOf([joris({ claimKind: 'membership', attribute: 'left' }), joris({ claimKind: 'membership', attribute: 'current', createdAt: '2026-10-01T11:00:00Z' })])).toBeNull();
  });

  it('a "left" role in the earlier stint is not listed as a role; a person who left again has no return', () => {
    const back = rejoinOf([
      joris({ value: 'junior', periodTo: '2020-12-31' }),
      joris({ value: 'left', periodTo: '2021-06-30', interviewedAt: '2021-07-01' }),
      joris({ claimKind: 'membership', attribute: 'rejoined', interviewedAt: '2026-09-01' }),
      joris({ value: 'architect', periodText: 'nu' }),
    ]);
    expect(back.earlier.map(e => e.value)).toEqual(['junior']);
    const goneAgain = [
      joris({ claimKind: 'membership', attribute: 'rejoined', interviewedAt: '2025-01-01', isMember: false }),
      joris({ claimKind: 'membership', attribute: 'left', interviewedAt: '2026-09-01', isMember: false }),
    ];
    expect(rejoinOf(goneAgain)).toBeNull();
    expect(leftOf(goneAgain)).toMatchObject({ membershipStatus: 'left', interviewedAt: '2026-09-01' });
  });
});
