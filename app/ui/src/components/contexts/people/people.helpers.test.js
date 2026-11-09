import { describe, it, expect } from 'vitest';
import {
  PEOPLE_FILTERS, STATUS_LABELS, STATUS_CHIP, statusTitle, SOURCE_CHIP_LABELS, sourceChipTitle, claimIcons,
  personContradictions, truncate, accessText, personLink, countsLine,
} from './people.helpers';

const SRC = { intervieweeName: 'Iris Interviewee', interviewedAt: '2026-10-01' };

describe('the vocabulary', () => {
  it('three filters, five statuses, never blue for a status', () => {
    expect(PEOPLE_FILTERS.map(f => f.label)).toEqual(['Current', 'Former', 'All']);
    expect(STATUS_LABELS).toEqual({ current: 'Current', cameBack: 'Came back', notConfirmed: 'Not confirmed', leftDecided: 'Left (decided)', left: 'Left' });
    expect(Object.keys(STATUS_CHIP)).toEqual(Object.keys(STATUS_LABELS));
    expect(Object.values(STATUS_CHIP).some(c => /\bblue-/.test(c))).toBe(false);
    expect(STATUS_CHIP.notConfirmed).toContain('border-dashed');
    expect(SOURCE_CHIP_LABELS).toEqual({ list: 'list', interview: 'interview', file: 'file', text: 'notes' });
  });
});

describe('statusTitle', () => {
  const decision = { by: 'analyst@example.test', at: '2026-10-23T10:00:00Z', overrides: 'Customer list (upload)' };

  it('says why: not confirmed, decided against the list, came back, left', () => {
    expect(statusTitle({ status: 'notConfirmed' })).toBe('A source says they are in it, but the member list does not list them');
    expect(statusTitle({ status: 'leftDecided', decision, stillListed: true })).toBe(
      'Decided by analyst@example.test, 2026-10-23: the interview is right — Customer list (upload) still lists them. Still listed in the source — remove it there or re-import without them.');
    expect(statusTitle({ status: 'cameBack', rejoined: { quote: 'Back since May', ...SRC, earlier: [{ value: 'tester' }] } }))
      .toBe('“Back since May” — interview with Iris Interviewee, 2026-10-01\nEarlier: Tester');
    expect(statusTitle({ status: 'left', left: { quote: null, ...SRC } })).toBe('interview with Iris Interviewee, 2026-10-01');
  });

  it('nothing to say for a current member, or a status whose fact is missing', () => {
    expect(statusTitle({ status: 'current' })).toBeUndefined();
    expect(statusTitle({ status: 'leftDecided', decision: null })).toBeUndefined();
    expect(statusTitle({ status: 'cameBack', rejoined: null })).toBeUndefined();
    expect(statusTitle({ status: 'left', left: null })).toBeUndefined();
  });
});

describe('sourceChipTitle', () => {
  it('names the list, else says what kind of source', () => {
    expect(sourceChipTitle('list', 'Customer list (upload)')).toBe('Listed by Customer list (upload)');
    expect(sourceChipTitle('list')).toBe('Listed by the member list');
    expect(['interview', 'file', 'text'].map(k => sourceChipTitle(k))).toEqual(['Said in an interview', 'In a file someone added', 'In notes someone added']);
  });
});

describe('claimIcons', () => {
  it('one icon per kind with claims, role · membership · history; proposed while any claim of it is', () => {
    const icons = claimIcons({ claims: [
      { id: 'h1', claimKind: 'roleHistory', status: 'confirmed' },
      { id: 'm1', claimKind: 'membership', status: 'confirmed' },
      { id: 'h2', claimKind: 'roleHistory', status: 'proposed' },
    ] });
    expect(icons.map(i => [i.key, i.label, i.state, i.claims.map(c => c.id)])).toEqual([
      ['membership', 'Membership', 'confirmed', ['m1']],
      ['history', 'History', 'proposed', ['h1', 'h2']],
    ]);
    expect(claimIcons({ claims: [{ id: 'r', claimKind: 'role', status: 'edited' }] })[0]).toMatchObject({ key: 'role', state: 'confirmed' });
    expect(claimIcons({ claims: [{ claimKind: 'property', status: 'proposed' }] })).toEqual([]);
    expect(claimIcons(null)).toEqual([]);
  });
});

describe('personContradictions', () => {
  it('the open ones the person is in, in the API\'s order', () => {
    const cons = [{ id: 'b', status: 'open' }, { id: 'a', status: 'open' }, { id: 'c', status: 'decided' }, { id: 'd', status: 'open' }];
    expect(personContradictions({ contradictions: ['a', 'b', 'c'] }, cons).map(c => c.id)).toEqual(['b', 'a']);
    expect(personContradictions({}, cons)).toEqual([]);
    expect(personContradictions({ contradictions: ['a'] }, undefined)).toEqual([]);
  });
});

describe('small words', () => {
  it('truncates at the limit with an ellipsis, and only past it', () => {
    expect(truncate('x'.repeat(200))).toBe('x'.repeat(200));
    expect(truncate(`${'x'.repeat(198)}  yy`)).toBe(`${'x'.repeat(198)}…`);
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate(null)).toBe('');
  });

  it('what is held: the count, 0 as 0, nobody matched as a dash', () => {
    expect([accessText(1234), accessText(0), accessText(null), accessText(undefined)]).toEqual(['1,234', '0', '–', '–']);
  });

  it('the name opens the account first, else the person, else nothing', () => {
    expect(personLink({ principalId: 'p', identityId: 'i' })).toEqual({ kind: 'user', id: 'p' });
    expect(personLink({ identityId: 'i' })).toEqual({ kind: 'identity', id: 'i' });
    expect(personLink({})).toBeNull();
  });

  it('the heading line counts current and former', () => {
    expect(countsLine({ current: 3, former: 4, all: 7 })).toBe('3 current · 4 former');
    expect(countsLine({})).toBe('0 current · 0 former');
    expect(countsLine(null)).toBe('');
  });
});
