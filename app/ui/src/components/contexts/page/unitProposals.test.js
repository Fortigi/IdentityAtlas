import { describe, it, expect } from 'vitest';
import { proposalCount, proposalSummary, proposalRows, countsLine, dayOf } from './unitProposals';

const LIST = [
  { id: 'inv-1', proposals: [{ id: 'a' }, { id: 'b' }] },
  { id: 'inv-2', proposals: [] },
  { id: 'inv-3', proposals: [{ id: 'c' }] },
];

describe('the count and the folded line', () => {
  it('counts the proposed roles over the investigations that hold one', () => {
    expect(proposalCount(LIST)).toBe(3);
    expect(proposalCount(null)).toBe(0);
    expect(proposalCount([{ id: 'x' }])).toBe(0);
    expect(proposalSummary(LIST)).toBe('3 in 2 investigations');
    expect(proposalSummary([LIST[2]])).toBe('1 in 1 investigation');
    expect(proposalSummary([LIST[1]])).toBe('None saved yet');
  });

  it('words the counts and the day', () => {
    expect(countsLine({ members: 1, entitlements: 2 })).toBe('1 person · 2 entitlements');
    expect(countsLine({ members: 4, entitlements: 1 })).toBe('4 people · 1 entitlement');
    expect(dayOf('2026-10-27T09:00:00')).toBe('27-10-2026');
    expect(dayOf('nope')).toBe('');
  });
});

describe('the rows', () => {
  const data = {
    unit: { displayName: 'Property Claims', accountable: { displayName: 'Ada Lead' } },
    columns: [{ id: 'br', isRole: true }, { id: 'r1', isRole: false }],
    people: [
      { key: 'i:ann', direct: true, jobTitle: 'Claims handler', accounts: [] },
      { key: 'i:bob', direct: true, jobTitle: 'Loss adjuster', accounts: [] },
      { key: 'i:cas', direct: true, jobTitle: 'Claims handler', accounts: [] },
    ],
  };
  const inv = (over) => ({ id: 'inv-1', name: 'First pass', updatedBy: 'ann', updatedAt: '2026-10-27T09:00:00', marks: [], ...over });

  it('evaluates a rule on the people now, says it in one sentence, and colours after the existing roles', () => {
    const rows = proposalRows([inv({ proposals: [
      { id: 'p1', name: ' Handler ', kind: 'rule', rule: { includeChildren: false, filters: { jobTitle: { values: [], contains: ['handler'] } } }, members: [], excluded: ['i:cas'], entitlements: ['r1', 'r2'] },
      { id: 'p2', name: '', kind: null, members: [], entitlements: [] },
      { id: 'p3', name: 'Adjuster', kind: 'requestable', members: ['i:bob'], entitlements: ['r1'] },
    ] })], data);
    expect(rows.map(r => [r.id, r.name, r.kind, r.members, r.entitlements, r.colorIdx])).toEqual([
      ['p1', 'Handler', 'rule-based', 1, 2, 1],
      ['p2', 'Unnamed', 'kind not chosen', 0, 0, null],
      ['p3', 'Adjuster', 'requestable', 1, 1, 2],
    ]);
    expect(rows[0].rule).toMatch(/^Everyone in Property Claims whose job title contains “handler”/);
    expect(rows[1].rule).toBe('Members chosen by hand');
    expect(rows[2].rule).toMatch(/^Requestable by anyone/);
    expect(rows[0]).toMatchObject({ investigationId: 'inv-1', investigationName: 'First pass', updatedBy: 'ann' });
  });

  it('keeps each investigation in order and colours each from the existing roles on', () => {
    const rows = proposalRows([
      inv({ id: 'a', proposals: [{ id: 'x', name: 'X', members: ['i:ann'], entitlements: [] }] }),
      inv({ id: 'b', proposals: [{ id: 'y', name: 'Y', members: [], entitlements: ['r1'] }] }),
    ], { ...data, columns: [] });
    expect(rows.map(r => [r.investigationId, r.id, r.colorIdx, r.rule])).toEqual([['a', 'x', 0, 'Members chosen by hand'], ['b', 'y', 0, 'Members chosen by hand']]);
  });

  it('says a rule-based role has no rule yet', () => {
    const [row] = proposalRows([inv({ proposals: [{ id: 'z', name: 'Z', kind: 'rule', rule: null, members: ['i:ann'], entitlements: ['r1'] }] })], data);
    expect(row).toMatchObject({ kind: 'rule-based', rule: 'No rule yet — members chosen by hand', members: 1 });
  });
});
