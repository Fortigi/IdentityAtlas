// Unit tests for the Access Reviewer Response report.
//
// The fold is where a reviewer is judged, so it is fed (reviewer, round) rows
// built to separate the cases: an open round that must not count as missed, a
// round outside the period that must vanish entirely, a fallback reviewer who
// decided without being asked. The SQL itself runs in the contract test.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import report, {
  REVIEWER_ROUNDS_SQL, VERDICT, VERDICT_COLORS, VERDICT_ORDER,
  buildRow, compareRows, foldReviewers, inPeriod, percent, summaries, verdictFor,
} from './access-reviewer-response.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 86400000).toISOString();
const ANN = '11111111-1111-1111-1111-111111111111';

const pair = (over = {}) => ({
  resourceId: 'br-1', round: 'i-1', key: ANN, name: 'Ann', upn: 'ann@x', contacted: true,
  decisions: 0, approvals: 0, denials: 0, justified: 0, lastDecision: null,
  endsAt: daysAgo(10), status: 'Completed',
  ...over,
});

beforeEach(() => { query.mockReset(); });

describe('foldReviewers', () => {
  it('counts asked and answered per finished round, and keeps open rounds apart', () => {
    const [ann] = foldReviewers([
      pair({ round: 'a', decisions: 3, approvals: 2, denials: 1, justified: 1, lastDecision: daysAgo(12) }),
      pair({ round: 'b' }),                                                   // asked, ignored
      pair({ round: 'c', resourceId: 'br-2', decisions: 1, approvals: 1, lastDecision: daysAgo(40) }),
      pair({ round: 'd', endsAt: daysAgo(-3), decisions: 2, approvals: 2, lastDecision: daysAgo(1) }), // open
    ], { periodDays: 365, now: NOW });
    expect(ann).toMatchObject({ asked: 3, answered: 2, open: 1, decisions: 6, approvals: 5, denials: 1, justified: 1 });
    expect([...ann.roles].sort()).toEqual(['br-1', 'br-2']);
    expect(ann.lastDecision).toBe(daysAgo(1));
  });

  it('drops a finished round outside the period entirely, decisions included', () => {
    const folded = foldReviewers([
      pair({ round: 'old', endsAt: daysAgo(400), decisions: 5 }),
      pair({ round: 'new', endsAt: daysAgo(30) }),
    ], { periodDays: 365, now: NOW });
    expect(folded[0]).toMatchObject({ asked: 1, answered: 0, decisions: 0 });
  });

  it('counts a reviewer who decided without being listed as asked, and keeps the first name seen', () => {
    const folded = foldReviewers([
      pair({ key: 'name:bob', name: null, upn: null, contacted: false, decisions: 1 }),
      pair({ key: 'name:bob', round: 'i-2', name: 'Bob', upn: null, contacted: false, decisions: 1 }),
    ], { periodDays: 365, now: NOW });
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ key: 'name:bob', name: 'Bob', asked: 2, answered: 2 });
  });
});

describe('inPeriod', () => {
  it('includes the boundary day and a round with no end date', () => {
    expect(inPeriod(daysAgo(365), 365, NOW)).toBe(true);
    expect(inPeriod(daysAgo(366), 365, NOW)).toBe(false);
    expect(inPeriod(null, 1, NOW)).toBe(true);
  });
});

describe('verdictFor', () => {
  it.each([
    [{ asked: 0, answered: 0 }, VERDICT.OPEN_ONLY],
    [{ asked: 4, answered: 0 }, VERDICT.NEVER],
    [{ asked: 10, answered: 4 }, VERDICT.MOSTLY_NOT],     // 40%
    [{ asked: 2, answered: 1 }, VERDICT.SOMETIMES],       // exactly 50%
    [{ asked: 10, answered: 8 }, VERDICT.SOMETIMES],      // 80%
    [{ asked: 10, answered: 9 }, VERDICT.CONSISTENT],     // exactly 90%
    [{ asked: 3, answered: 3 }, VERDICT.CONSISTENT],
  ])('%o is %s', (r, verdict) => {
    expect(verdictFor(r)).toBe(verdict);
  });
});

describe('percent', () => {
  it('is a whole percent, or null with nothing to divide', () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(0, 0)).toBeNull();
  });
});

describe('buildRow', () => {
  const folded = {
    key: ANN, name: 'Ann (from review)', upn: 'ann@review', asked: 4, answered: 3, open: 1, roles: new Set(['a', 'b']),
    decisions: 8, approvals: 6, denials: 2, justified: 1, lastDecision: daysAgo(7),
  };

  it('prefers the synced account for who the reviewer is, and links to it', () => {
    const row = buildRow(folded, { id: ANN, displayName: 'Ann Manager', email: 'ann@corp', department: 'Finance' }, NOW);
    expect(row).toEqual({
      reviewer: 'Ann Manager', email: 'ann@corp', department: 'Finance', verdict: VERDICT.SOMETIMES,
      roundsAsked: 4, roundsAnswered: 3, roundsMissed: 1, responseRate: 75, businessRoles: 2,
      decisions: 8, approvedShare: 75, deniedShare: 25, justifiedShare: 13,
      lastDecision: daysAgo(7).slice(0, 10), daysSinceLastDecision: 7, openRounds: 1,
      _entity: { kind: 'user', id: ANN },
    });
    for (const col of report.columns) expect(row, col.key).toHaveProperty(col.key);
  });

  it('falls back to the review\'s own name, then the UPN, then the key, with no link', () => {
    expect(buildRow(folded, undefined, NOW)).toMatchObject({ reviewer: 'Ann (from review)', email: 'ann@review', department: null });
    expect(buildRow(folded, undefined, NOW)._entity).toBeUndefined();
    expect(buildRow({ ...folded, name: null }, undefined, NOW).reviewer).toBe('ann@review');
    const bare = buildRow({ ...folded, key: 'name:carl', name: null, upn: null, decisions: 0, lastDecision: null }, undefined, NOW);
    expect(bare).toMatchObject({
      reviewer: 'carl', email: null, approvedShare: null, lastDecision: null, daysSinceLastDecision: null,
    });
  });
});

describe('compareRows', () => {
  it('worst verdict first, then most reviews missed, then name', () => {
    const rows = [
      { verdict: VERDICT.CONSISTENT, roundsMissed: 0, reviewer: 'A' },
      { verdict: VERDICT.NEVER, roundsMissed: 2, reviewer: 'B' },
      { verdict: VERDICT.NEVER, roundsMissed: 5, reviewer: 'C' },
      { verdict: VERDICT.SOMETIMES, roundsMissed: 1, reviewer: 'E' },
      { verdict: VERDICT.SOMETIMES, roundsMissed: 1, reviewer: 'D' },
      { verdict: VERDICT.OPEN_ONLY, roundsMissed: 0, reviewer: 'F' },
    ].sort(compareRows);
    expect(rows.map(r => r.reviewer)).toEqual(['C', 'B', 'D', 'E', 'A', 'F']);
  });

  it('orders and colours every verdict', () => {
    expect(new Set(VERDICT_ORDER)).toEqual(new Set(Object.values(VERDICT)));
    expect(Object.keys(VERDICT_COLORS).sort()).toEqual([...VERDICT_ORDER].sort());
  });
});

describe('summaries', () => {
  const rows = [
    { verdict: VERDICT.NEVER, roundsAsked: 3, roundsAnswered: 0 },
    { verdict: VERDICT.CONSISTENT, roundsAsked: 5, roundsAnswered: 5 },
  ];

  it('totals the answered share and counts the two ends', () => {
    const [first, ...rest] = summaries(rows, [{ contacted: true }], 180);
    expect(first.text).toBe('2 reviewer(s) over review rounds that ended in the last 180 days: '
      + '5 of 8 requested reviews answered by the reviewer themselves (63%). 1 never responded, 1 review consistently.');
    expect(rest).toEqual([]);
  });

  it('warns that nobody can be "never responded" when no source recorded who was asked', () => {
    const notices = summaries(rows, [{ contacted: false }], 365);
    expect(notices[1]).toMatchObject({ severity: 'warning' });
    expect(notices[1].text).toContain('Entra ID crawler');
  });

  it('reads 0% rather than null when nothing was asked, and warns when nothing was synced', () => {
    expect(summaries([], [{ contacted: true }], 30)[0].text).toContain('0 of 0 requested reviews answered by the reviewer themselves (0%)');
    expect(summaries([], [], 30)).toEqual([{
      severity: 'warning', text: 'No access review decisions have been synced, so there is no reviewer to report on.',
    }]);
  });
});

describe('the template', () => {
  it('declares a list with one optional period, and pivots and pies over its own columns', () => {
    expect(report).toMatchObject({ name: 'access-reviewer-response', form: 'list' });
    expect(Object.keys(report.parametersSchema.properties)).toEqual(['periodDays']);
    const keys = new Set(report.columns.map(c => c.key));
    for (const p of report.pivots) for (const k of [...p.rows, ...p.values]) expect(keys.has(k), k).toBe(true);
    for (const c of report.charts) expect(keys.has(c.category) && (!c.value || keys.has(c.value))).toBe(true);
  });

  it('reads who was asked once per round, and counts only decisions a person made', () => {
    expect(REVIEWER_ROUNDS_SQL).toContain(`DISTINCT ON ("resourceId", round)`);
    expect(REVIEWER_ROUNDS_SQL).toContain(`jsonb_typeof(ext->'contactedReviewers') = 'array'`);
    expect(REVIEWER_ROUNDS_SQL).toContain('FROM d WHERE human');
    expect(REVIEWER_ROUNDS_SQL).toContain('FULL JOIN decided x');
  });

  it('runs: folds, looks up only the keys that are ids, sorts worst first', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          pair({ key: ANN, round: 'r1', decisions: 2, approvals: 2, lastDecision: daysAgo(11) }),
          pair({ key: 'name:bob', name: 'Bob', upn: null, round: 'r1' }),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: ANN, displayName: 'Ann Manager', email: 'ann@corp', department: 'Finance' }] });
    const log = vi.fn();
    const { rows, notices } = await report.run({ periodDays: 'nonsense' }, { log });

    expect(query.mock.calls[1][1]).toEqual([[ANN]]);
    expect(rows.map(r => [r.reviewer, r.verdict])).toEqual([['Bob', VERDICT.NEVER], ['Ann Manager', VERDICT.CONSISTENT]]);
    expect(notices[0].text).toContain('last 365 days');
    expect(log).toHaveBeenCalledWith('access-reviewer-response report: 2 reviewer(s)');
  });

  it('skips the account lookup when no reviewer key is an id', async () => {
    query.mockResolvedValueOnce({ rows: [pair({ key: 'name:bob', name: 'Bob' })] });
    const { rows } = await report.run({}, undefined);
    expect(query).toHaveBeenCalledTimes(1);
    expect(rows[0].reviewer).toBe('Bob');
  });
});
