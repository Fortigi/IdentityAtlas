import { describe, it, expect } from 'vitest';
import { factTitle, factClass, earlierRolesText, rejoinedTitle, decisionText, STILL_LISTED_HINT } from './memberInterview.helpers';

const SRC = { intervieweeName: 'Piet de Vries', interviewedAt: '2026-10-01' };
const left = (over) => ({ membershipStatus: 'left', status: 'proposed', quote: 'Jan Smit just left the account', ...SRC, ...over });

describe('factTitle', () => {
  it('the quote with its source, or the source alone; a file names the file', () => {
    expect(factTitle(left({}))).toBe('“Jan Smit just left the account” — interview with Piet de Vries, 2026-10-01');
    expect(factTitle(left({ quote: null }))).toBe('interview with Piet de Vries, 2026-10-01');
    expect(factTitle(left({ quote: null, sourceKind: 'file', fileName: 'team.xlsx' }))).toBe('team.xlsx, 2026-10-01');
  });
});

describe('factClass', () => {
  it('proposed reads dashed and italic; confirmed and edited plain', () => {
    expect(factClass('proposed')).toContain('border-dashed');
    expect(factClass('proposed')).toContain('italic');
    expect(factClass('confirmed')).toBe('');
    expect(factClass('edited')).toBe('');
  });
});

describe('the earlier stint of someone who came back', () => {
  const back = { quote: 'Joris is back, now as architect', ...SRC, earlier: [{ value: 'junior developer', periodTo: '2020-12-31' }, { value: 'tester' }] };

  it('names the earlier roles, capitalised, oldest first; none is empty', () => {
    expect(earlierRolesText(back)).toBe('Junior developer → Tester');
    expect(earlierRolesText({ earlier: [] })).toBe('');
    expect(earlierRolesText(null)).toBe('');
  });

  it('the tooltip: what was said, then the earlier roles with their periods', () => {
    expect(rejoinedTitle(back)).toBe('“Joris is back, now as architect” — interview with Piet de Vries, 2026-10-01\nEarlier: Junior developer (until 2020) → Tester');
    expect(rejoinedTitle({ ...back, earlier: [] })).toBe('“Joris is back, now as architect” — interview with Piet de Vries, 2026-10-01');
  });
});

describe('decisionText', () => {
  const decision = { by: 'analyst@example.test', at: '2026-10-23T10:00:00Z', overrides: 'Klanten (upload)' };

  it('who decided and when, and the list that still has them', () => {
    expect(decisionText(decision)).toBe('Decided by analyst@example.test, 2026-10-23: the interview is right — Klanten (upload) still lists them');
    expect(decisionText(decision, false)).toBe('Decided by analyst@example.test, 2026-10-23: the interview is right');
    expect(decisionText({ ...decision, by: null, at: null })).toBe('Decided: the interview is right — Klanten (upload) still lists them');
    expect(STILL_LISTED_HINT).toMatch(/remove it there/);
  });
});
