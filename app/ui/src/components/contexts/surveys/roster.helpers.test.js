// The roster: one row per person, the newest claim of each kind counting.
import { describe, it, expect } from 'vitest';
import { buildRoster, rosterCounts } from './roster.helpers';

const KIM = 'p-kim';
const TOM = 'p-tom';
const NEW = 'p-new';
const claim = (over) => ({
  claimKind: 'membership', subjectKind: 'Person', status: 'confirmed', interviewedAt: '2026-10-01', createdAt: '2026-10-01T10:00:00Z', ...over,
});

describe('buildRoster', () => {
  const members = [
    { id: KIM, displayName: 'Kim Los', jobTitle: 'Data scientist', department: 'Innovation' },
    { id: TOM, displayName: 'Thom Oskam', jobTitle: 'Intern' },
    { id: 'p-ann', displayName: 'Ann Akker' },
  ];

  it('colours each member by the newest membership claim; a later survey overrides an earlier interview', () => {
    const rows = buildRoster(members, [
      claim({ principalId: KIM, attribute: 'former', interviewedAt: '2026-09-01' }),
      claim({ principalId: KIM, attribute: 'current', interviewedAt: '2026-10-05' }),
      claim({ principalId: TOM, attribute: 'left' }),
    ]);
    expect(rows.map(r => [r.name, r.state, r.jobTitle, r.member])).toEqual([
      ['Ann Akker', 'unknown', null, true],
      ['Kim Los', 'here', 'Data scientist', true],
      ['Thom Oskam', 'gone', 'Intern', true],
    ]);
    expect(rosterCounts(rows)).toEqual({ here: 1, gone: 1, unknown: 1 });
  });

  it('on the same date the claim made last counts', () => {
    const [row] = buildRoster([members[0]], [
      claim({ principalId: KIM, attribute: 'current', createdAt: '2026-10-01T11:00:00Z' }),
      claim({ principalId: KIM, attribute: 'left', createdAt: '2026-10-01T09:00:00Z' }),
    ]);
    expect(row.state).toBe('here');
  });

  it('a rejected claim counts for nothing, and a row is reviewed only when every claim used is decided', () => {
    const [kim] = buildRoster([members[0]], [
      claim({ principalId: KIM, attribute: 'left', status: 'rejected', interviewedAt: '2026-10-09' }),
      claim({ principalId: KIM, attribute: 'current' }),
      claim({ principalId: KIM, claimKind: 'role', attribute: 'member', value: 'Data scientist', status: 'proposed' }),
    ]);
    expect(kim.state).toBe('here');
    expect(kim.reviewed).toBe(false);
    expect(kim.role).toBe('Data scientist');
    const [plain] = buildRoster([members[0]], []);
    expect(plain.reviewed).toBe(false);
  });

  it('role in words, responsibilities collected, stated roles named; claims about a person-level holder count for a people unit', () => {
    const [row] = buildRoster([{ id: 'i-kim', displayName: 'Kim' }], [
      claim({ identityId: 'i-kim', claimKind: 'role', attribute: 'member', value: 'Analyst', interviewedAt: '2026-09-01' }),
      claim({ identityId: 'i-kim', claimKind: 'role', attribute: 'member', value: 'Lead analyst' }),
      claim({ identityId: 'i-kim', claimKind: 'role', attribute: 'other', value: 'Route scanner' }),
      claim({ identityId: 'i-kim', claimKind: 'role', attribute: 'other', value: 'Route scanner' }),
      claim({ identityId: 'i-kim', claimKind: 'role', attribute: 'dayToDay', value: 'x' }),
      claim({ identityId: 'i-kim', claimKind: 'role', attribute: 'owner', value: 'x' }),
    ]);
    expect(row).toMatchObject({ role: 'Lead analyst', responsibleFor: ['Route scanner'], roles: ['Day-to-day', 'Owner'], reviewed: true });
  });

  it('adds a person the claims say works (or worked) here who is not a member; not someone only given a role', () => {
    const rows = buildRoster([], [
      claim({ principalId: NEW, subjectDisplayName: 'Nina Nieuw', attribute: 'joined' }),
      claim({ subjectName: 'Piet', principalId: null, attribute: 'former' }),
      claim({ principalId: 'p-x', claimKind: 'role', attribute: 'other', value: 'x' }),
      claim({ claimKind: 'description', subjectKind: 'Context', value: 'x' }),
    ]);
    expect(rows.map(r => [r.name, r.state, r.member, r.id])).toEqual([['Nina Nieuw', 'here', false, NEW], ['Piet', 'gone', false, null]]);
  });

  it('ignores claims about resources and the context', () => {
    const [row] = buildRoster([members[0]], [claim({ subjectKind: 'Resource', principalId: KIM, attribute: 'current' })]);
    expect(row.state).toBe('unknown');
  });
});
