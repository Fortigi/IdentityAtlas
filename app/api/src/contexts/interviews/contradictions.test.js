// Which claims contradict a fact or each other — one test per rule, each with
// inputs that would pass a sloppier rule (a member who came back, a value that
// differs only in case, the holder themselves named as owner). Invented names.
import { describe, it, expect, vi } from 'vitest';
import {
  findContradictions, loadContradictions, memberListName, memberListSource, CONTRADICTION_CONTEXT_SQL, CONTRADICTION_MEMBERS_SQL,
} from './contradictions.js';

const JAN = 'aaaaaaaa-0000-4000-8000-000000000001';
const PIET = 'aaaaaaaa-0000-4000-8000-000000000002';
const YARA = 'aaaaaaaa-0000-4000-8000-000000000003';
const PERSON = 'bbbbbbbb-0000-4000-8000-000000000001';
const CTX = 'dddddddd-0000-4000-8000-000000000001';

let n = 0;
const claim = (over) => ({
  id: `c-${++n}`, interviewId: 'iv-1', claimKind: 'membership', attribute: 'former', value: 'former', status: 'proposed',
  quote: 'q', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', createdAt: '2026-10-01T10:00:00Z', ...over,
});
const UPLOAD = { targetType: 'Principal', variant: 'synced', systemName: 'HR export (upload)', lastSyncAt: '2026-10-20T08:00:00Z', extendedAttributes: { sector: 'Shipping' } };
const member = (id) => new Map([[id, { addedBy: 'sync', addedAt: '2026-09-01T00:00:00Z' }]]);
const find = (over) => findContradictions({ context: UPLOAD, ...over });

describe('the member list as a source', () => {
  it('named after its system, by hand, or the rule; with when it was synced or the member listed', () => {
    expect(memberListName(UPLOAD)).toBe('HR export (upload)');
    expect(memberListName({ variant: 'manual', systemName: 'x' })).toBe('The member list');
    expect(memberListName({ variant: 'generated' })).toBe('The rule that derives it');
    expect(memberListName({ variant: 'synced' })).toBe('The source');
    expect(memberListSource(UPLOAD, null)).toBe('HR export (upload), last synced 2026-10-20');
    expect(memberListSource({ variant: 'synced', systemName: 'HR' }, { addedAt: '2026-09-01T00:00:00Z' })).toBe('HR, listed since 2026-09-01');
    expect(memberListSource({ variant: 'synced', systemName: 'HR' }, null)).toBe('HR');
    expect(memberListSource({ variant: 'manual' }, { addedAt: new Date('2026-09-02T00:00:00Z') })).toBe('The member list, added 2026-09-02');
    expect(memberListSource({ variant: 'manual' }, null)).toBe('The member list');
  });
});

describe('leftButMember — the interview says they left, the list still has them', () => {
  // Mirrors the demo unit (invented names): "Gerrit doet data mining; Lotte deed dat ook,
  // maar is recent uitgestroomd" — Lotte's former claim, Lotte still in the uploaded list.
  it('the pair, with the claim and the list each named with their source', () => {
    const lotte = claim({ principalId: JAN, subjectName: 'Lotte', subjectDisplayName: 'Lotte Lindeboom', quote: 'Lotte deed dat ook, maar is recent uitgestroomd.' });
    const [con, ...rest] = find({ claims: [lotte], members: member(JAN) });
    expect(rest).toEqual([]);
    expect(con).toMatchObject({
      id: `leftButMember:${lotte.id}`, rule: 'leftButMember', status: 'open', resolution: null, claimIds: [lotte.id],
      claim: { kind: 'claim', statement: 'Interview: Lotte Lindeboom is a former member', claim: { id: lotte.id, quote: 'Lotte deed dat ook, maar is recent uitgestroomd.', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01' } },
      other: { kind: 'fact', statement: 'HR export (upload) still lists Lotte Lindeboom as a member', source: 'HR export (upload), last synced 2026-10-20' },
    });
  });

  it('a role claim that says left counts; not a member, came back, or a corrected "current" is no contradiction', () => {
    const left = claim({ claimKind: 'roleHistory', attribute: 'other', value: 'recently left', principalId: JAN, subjectName: 'Jan' });
    expect(find({ claims: [left], members: member(JAN) }).map(c => [c.rule, c.claim.statement])).toEqual([['leftButMember', 'Interview: Jan left']]);
    expect(find({ claims: [left], members: new Map() })).toEqual([]);
    const back = [claim({ principalId: JAN, subjectName: 'Jan' }), claim({ principalId: JAN, subjectName: 'Jan', attribute: 'rejoined', interviewedAt: '2026-10-05' })];
    expect(find({ claims: back, members: member(JAN) })).toEqual([]);
    expect(find({ claims: [claim({ principalId: JAN, attribute: 'current', value: 'x (corrected: the sentence says current; the model said former)' })], members: member(JAN) })).toEqual([]);
  });

  it('a later word that they are in it wins over the older "left"', () => {
    const claims = [
      claim({ principalId: JAN, subjectName: 'Jan', interviewedAt: '2026-01-01' }),
      claim({ principalId: JAN, subjectName: 'Jan', attribute: 'current', value: 'current', interviewedAt: '2026-09-01' }),
    ];
    expect(find({ claims, members: member(JAN) }).map(c => c.rule)).toEqual(['claims']);
  });

  it('decided by the claim: confirmed = the interview is right, edited with a period = both, rejected = the list is right', () => {
    const decided = (over) => find({ claims: [claim({ principalId: JAN, decidedBy: 'analyst@example.test', decidedAt: '2026-10-02T09:00:00Z', ...over })], members: member(JAN) })[0];
    expect(decided({ status: 'confirmed' })).toMatchObject({ status: 'decided', resolution: 'interview', decidedBy: 'analyst@example.test', decidedAt: '2026-10-02T09:00:00Z' });
    expect(decided({ status: 'edited', periodText: 'in 2025' })).toMatchObject({ status: 'decided', resolution: 'both' });
    expect(decided({ status: 'edited' })).toMatchObject({ resolution: 'interview' });
    expect(decided({ status: 'rejected' })).toMatchObject({ status: 'decided', resolution: 'source' });
  });

  it('a context of persons compares the person, and a context of resources has no member rules', () => {
    const persons = { ...UPLOAD, targetType: 'Identity' };
    expect(findContradictions({ context: persons, claims: [claim({ identityId: PERSON })], members: member(PERSON) })).toHaveLength(1);
    expect(findContradictions({ context: persons, claims: [claim({ principalId: JAN })], members: member(JAN) })).toEqual([]);
    expect(findContradictions({ context: { ...UPLOAD, targetType: 'Resource' }, claims: [claim({ principalId: JAN })], members: member(JAN) })).toEqual([]);
  });
});

describe('memberNotListed — the interview says they are in it, the list does not have them', () => {
  it('current, joined and rejoined; a name nobody matched is not compared', () => {
    for (const [attribute, words] of [['current', 'is a member'], ['joined', 'joined'], ['rejoined', 'is back (rejoined)']]) {
      const c = claim({ principalId: PIET, subjectDisplayName: 'Piet Proef', attribute, value: attribute });
      expect(find({ claims: [c], members: new Map() }).map(x => [x.rule, x.claim.statement, x.other.statement])).toEqual([
        ['memberNotListed', `Interview: Piet Proef ${words}`, 'HR export (upload) does not list Piet Proef'],
      ]);
      expect(find({ claims: [c], members: member(PIET) })).toEqual([]);
    }
    expect(find({ claims: [claim({ subjectName: 'Kees', attribute: 'current' })], members: new Map() })).toEqual([]);
  });
});

describe('accountable / notOwner — the interview and the Accountable disagree', () => {
  const HOLDER = { principalId: YARA, displayName: 'Yara Ypma', addedBy: 'sync' };

  it('another person suggested as Accountable; the holder themselves is no contradiction', () => {
    const other = claim({ claimKind: 'role', attribute: 'owner', roleSuggestion: 'Accountable', principalId: PIET, subjectDisplayName: 'Piet Proef' });
    const self = claim({ claimKind: 'role', attribute: 'owner', roleSuggestion: 'Accountable', principalId: YARA });
    const unmatched = claim({ claimKind: 'role', attribute: 'owner', roleSuggestion: 'Accountable', subjectName: 'Kees' });
    const out = find({ claims: [other, self, unmatched], accountable: HOLDER });
    expect(out.map(c => [c.rule, c.claim.statement, c.other.statement, c.other.source])).toEqual([
      ['accountable', 'Interview: Piet Proef is the owner', 'Yara Ypma is the Accountable', 'Yara Ypma, from the source'],
    ]);
  });

  it('names the owner a synced context\'s source states (sourceOwner) as from the source too', () => {
    const doubt = claim({ claimKind: 'role', attribute: 'notOwner', value: 'not the owner', principalId: YARA, subjectDisplayName: 'Yara Ypma' });
    const out = find({ claims: [doubt], accountable: { ...HOLDER, addedBy: 'sourceOwner' } });
    expect(out.map(c => c.other.source)).toEqual(['Yara Ypma, from the source']);
  });

  it('the Accountable says they are not the owner (the old "In doubt")', () => {
    const doubt = claim({ claimKind: 'role', attribute: 'notOwner', value: 'not the owner', principalId: YARA, subjectDisplayName: 'Yara Ypma' });
    const out = find({ claims: [doubt], accountable: { ...HOLDER, addedBy: 'analyst' } });
    expect(out.map(c => [c.rule, c.claim.statement, c.other.source])).toEqual([['notOwner', 'Interview: Yara Ypma says they are not the owner', 'Yara Ypma, set by an analyst']]);
    expect(find({ claims: [doubt], accountable: null })).toEqual([]);
    expect(find({ claims: [doubt], accountable: { principalId: PIET, displayName: 'P', addedBy: 'algorithm' } })).toEqual([]);
    expect(find({ claims: [claim({ claimKind: 'role', attribute: 'owner', roleSuggestion: 'Accountable', principalId: PIET })], accountable: { displayName: 'none' } })).toEqual([]);
  });

  it('two different people named as owner, neither the holder, are a pair', () => {
    const a = claim({ claimKind: 'role', attribute: 'owner', principalId: PIET, subjectDisplayName: 'Piet Proef', interviewedAt: '2026-10-02' });
    const b = claim({ claimKind: 'role', attribute: 'owner', principalId: JAN, subjectDisplayName: 'Jan Smit' });
    const again = claim({ claimKind: 'role', attribute: 'owner', principalId: PIET, subjectDisplayName: 'Piet Proef' });
    const out = find({ claims: [a, b, again] });
    expect(out.map(c => [c.rule, c.claim.statement, c.other.statement])).toEqual([['claims', 'Interview: Piet Proef is the owner', 'Interview: Jan Smit is the owner']]);
    expect(find({ claims: [a, again] })).toEqual([]);
  });
});

describe('property — the interview gives another value than the context holds', () => {
  it('a different value is a contradiction; the same value in other case or spacing is not; no stored value, none', () => {
    const out = find({ claims: [
      claim({ claimKind: 'property', attribute: 'sector', value: 'port logistics' }),
      claim({ claimKind: 'property', attribute: 'sector', value: '  SHIPPING ' }),
      claim({ claimKind: 'property', attribute: 'vendor', value: 'Acme' }),
    ] });
    expect(out.filter(c => c.rule === 'property').map(c => [c.claim.statement, c.other.statement, c.other.source])).toEqual([
      ['Interview: sector is port logistics', 'sector is Shipping', 'HR export (upload)'],
    ]);
    expect(findContradictions({ context: { ...UPLOAD, systemName: null }, claims: [claim({ claimKind: 'property', attribute: 'sector', value: 'x' })] })[0].other.source).toBe('the context');
  });

  it('two claims with two values for one attribute are a pair, newest first; a third with a known value adds nothing', () => {
    const a = claim({ claimKind: 'property', attribute: 'Hosting', value: 'on premises', interviewedAt: '2026-10-03' });
    const b = claim({ claimKind: 'property', attribute: 'hosting', value: 'Azure' });
    const c = claim({ claimKind: 'property', attribute: 'hosting', value: 'azure' });
    const pairs = findContradictions({ context: { ...UPLOAD, extendedAttributes: null }, claims: [a, b, c] }).filter(x => x.rule === 'claims');
    expect(pairs.map(x => [x.claim.statement, x.other.statement])).toEqual([['Interview: Hosting is on premises', 'Interview: hosting is Azure']]);
  });
});

describe('claims — two interviews disagree about one person', () => {
  const current = (over) => claim({ principalId: JAN, subjectDisplayName: 'Jan Smit', attribute: 'current', value: 'current', interviewedAt: '2026-10-05', ...over });
  const gone = (over) => claim({ principalId: JAN, subjectDisplayName: 'Jan Smit', attribute: 'left', value: 'left', ...over });

  it('one says current, another left: a pair, oldest first, open while either is proposed', () => {
    const out = find({ claims: [current(), gone()], members: new Map() });
    const pair = out.find(c => c.rule === 'claims');
    expect([pair.claim.statement, pair.other.statement, pair.status]).toEqual(['Interview: Jan Smit left', 'Interview: Jan Smit is a member', 'open']);
  });

  it('decided by rejecting one (the other is kept), both (rejoined: both confirmed), or neither', () => {
    const state = (a, b) => find({ claims: [gone(a), current(b)], members: member(JAN) }).find(c => c.rule === 'claims');
    expect(state({ status: 'rejected', decidedAt: '2026-10-06T00:00:00Z' }, {})).toMatchObject({ status: 'decided', resolution: 'second', decidedAt: '2026-10-06T00:00:00Z' });
    expect(state({}, { status: 'rejected' })).toMatchObject({ status: 'decided', resolution: 'first' });
    expect(state({ status: 'rejected' }, { status: 'rejected' })).toMatchObject({ status: 'decided', resolution: 'neither' });
    expect(state({ status: 'confirmed', decidedAt: '2026-10-06T00:00:00Z' }, { status: 'confirmed', decidedAt: '2026-10-07T00:00:00Z' }))
      .toMatchObject({ status: 'decided', resolution: 'both', decidedAt: '2026-10-07T00:00:00Z' });
    expect(state({ status: 'confirmed' }, {})).toMatchObject({ status: 'open', decidedAt: null });
  });

  it('a "rejoined" claim, or a return said in words, explains the "left": no pair', () => {
    expect(find({ claims: [gone(), current({ attribute: 'rejoined' })], members: member(JAN) })).toEqual([]);
    const words = claim({ claimKind: 'roleHistory', attribute: 'other', principalId: JAN, value: 'architect', subjectName: 'Jan Smit', quote: 'Jan Smit kwam terug als architect.' });
    expect(find({ claims: [gone(), current(), words], members: member(JAN) })).toEqual([]);
  });

  it('aliases never contradict anything', () => {
    expect(find({ claims: [claim({ claimKind: 'alias', value: 'Kade' }), claim({ claimKind: 'alias', value: 'Haven' })] })).toEqual([]);
  });

  it('open ones first', () => {
    const out = find({ claims: [claim({ principalId: JAN, status: 'rejected' }), current({ principalId: PIET })], members: member(JAN) });
    expect(out.map(c => c.status)).toEqual(['open', 'decided']);
  });
});

describe('loadContradictions', () => {
  it('two statements: the context with its source, then the members among the people named', async () => {
    const db = { query: vi.fn(async (sql) => ({ rows: sql === CONTRADICTION_CONTEXT_SQL ? [UPLOAD] : [{ memberId: JAN, addedBy: 'sync', addedAt: '2026-09-01' }] })) };
    const out = await loadContradictions(db, CTX, [claim({ principalId: JAN }), claim({ principalId: JAN, claimKind: 'role', attribute: 'member', value: 'x' }), claim({ subjectName: 'Kees' })], null);
    expect(db.query.mock.calls).toEqual([[CONTRADICTION_CONTEXT_SQL, [CTX]], [CONTRADICTION_MEMBERS_SQL, [CTX, [JAN]]]]);
    expect(out.map(c => c.rule)).toEqual(['leftButMember']);
  });

  it('asks nothing without claims; nothing more for an unknown context or nobody matched', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await loadContradictions(db, CTX, [], null)).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
    expect(await loadContradictions(db, CTX, [claim({ principalId: JAN })], null)).toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(1);
    const ctxOnly = { query: vi.fn(async () => ({ rows: [{ ...UPLOAD, targetType: 'Resource' }] })) };
    await loadContradictions(ctxOnly, CTX, [claim({ principalId: JAN })], null);
    expect(ctxOnly.query).toHaveBeenCalledTimes(1);
  });
});
