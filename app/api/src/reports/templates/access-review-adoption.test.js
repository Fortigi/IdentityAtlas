// Unit tests for the Access Review Adoption report.
//
// The status a role gets is the whole point of the report, so every branch of
// `classify` is hit with a role built to sit right next to the neighbouring
// branch (one day either side of a threshold, one decision short of "fully by a
// person"). The SQL runs for real in the contract test; here the mocked db
// hands the template folded rows and the assertions are on what it makes of them.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import report, {
  ROLE_REVIEW_SQL, STATUS, STATUS_COLORS, STATUS_ORDER, buildRow, classify, compareRows, isNewRole, isTrue,
  reviewNotRequired, reviewRequiredLabel, share, splitNotRequired, summaries,
} from './access-review-adoption.js';

const NOW = new Date('2026-10-22T12:00:00Z');
const OPTIONS = { newRoleDays: 90, staleAfterDays: 365, now: NOW };
const daysAgo = n => new Date(NOW.getTime() - n * 86400000).toISOString();

// A role reviewed properly by a person 30 days ago, in a round that has ended.
const role = (over = {}) => ({
  id: 'br-1', displayName: 'Finance clerk', systemName: 'Entra ID', createdDateTime: daysAgo(800),
  reviews: 3, humanReviews: 2, lastHumanAt: daysAgo(30),
  latestEndsAt: daysAgo(20), latestStatus: 'Completed', latestDecisions: 4, latestByPerson: 4,
  defaultDecision: 'Approve', lastHumanReviewer: 'Ann Manager', members: 12, policies: 1, reviewRequired: true,
  ...over,
});

beforeEach(() => {
  query.mockReset();
});

describe('classify', () => {
  it('is Reviewed by a person when the latest, finished round was fully a person\'s, recently', () => {
    expect(classify(role(), OPTIONS)).toBe(STATUS.REVIEWED);
  });

  it('is No review yet for an old role that never had a round', () => {
    expect(classify(role({ reviews: 0, createdDateTime: daysAgo(90) }), OPTIONS)).toBe(STATUS.NO_REVIEW);
  });

  it('is New for a role younger than the threshold with no round yet', () => {
    expect(classify(role({ reviews: 0, createdDateTime: daysAgo(89) }), OPTIONS)).toBe(STATUS.NEW);
  });

  it('is No review yet when the creation date is unknown — "new" needs proof', () => {
    expect(classify(role({ reviews: 0, createdDateTime: null }), OPTIONS)).toBe(STATUS.NO_REVIEW);
  });

  it('is Review in progress while the latest round is still open, before any human verdict', () => {
    expect(classify(role({ latestEndsAt: daysAgo(-5), humanReviews: 0, latestByPerson: 0 }), OPTIONS)).toBe(STATUS.IN_PROGRESS);
    expect(classify(role({ latestEndsAt: null, latestStatus: 'InProgress' }), OPTIONS)).toBe(STATUS.IN_PROGRESS);
  });

  it('is Never reviewed by a person when rounds were held but no person ever decided', () => {
    // The Entra case the report exists for: every round completed by the default decision.
    expect(classify(role({ humanReviews: 0, lastHumanAt: null, latestByPerson: 0 }), OPTIONS)).toBe(STATUS.NEVER_BY_PERSON);
  });

  it('is Latest review not by a person when a person reviewed once, but not this time', () => {
    expect(classify(role({ latestByPerson: 0 }), OPTIONS)).toBe(STATUS.LATEST_NOT_BY_PERSON);
  });

  it('is Latest review partly by a person when one decision of the round was the platform\'s', () => {
    expect(classify(role({ latestByPerson: 3 }), OPTIONS)).toBe(STATUS.LATEST_PARTLY);
  });

  it('is too long ago only past the threshold, not on it', () => {
    expect(classify(role({ lastHumanAt: daysAgo(366) }), OPTIONS)).toBe(STATUS.STALE);
    expect(classify(role({ lastHumanAt: daysAgo(365) }), OPTIONS)).toBe(STATUS.REVIEWED);
  });
});

describe('roles that do not require a review', () => {
  // Never reviewed, has policies, and every policy says "no review".
  const notRequired = role({ reviews: 0, policies: 2, reviewRequired: false });

  it('is only a role with policies, none requiring review, and no review ever held', () => {
    expect(reviewNotRequired(notRequired)).toBe(true);
    // One policy requiring review is enough to keep it.
    expect(reviewNotRequired({ ...notRequired, reviewRequired: true })).toBe(false);
    // No policy data: the source may simply not say — keep it.
    expect(reviewNotRequired({ ...notRequired, policies: 0, reviewRequired: null })).toBe(false);
    // Policies that do not state it (null) are not a "no".
    expect(reviewNotRequired({ ...notRequired, reviewRequired: null })).toBe(false);
    // Reviewed anyway: the review is a fact, keep it.
    expect(reviewNotRequired({ ...notRequired, reviews: 1 })).toBe(false);
  });

  it('are left out by default and counted, and kept when asked', () => {
    const roles = [notRequired, role(), role({ reviews: 0, policies: 0, reviewRequired: null })];
    const out = splitNotRequired(roles, false);
    expect(out.kept).toEqual([roles[1], roles[2]]);
    expect(out.left).toBe(1);
    expect(splitNotRequired(roles, true)).toEqual({ kept: roles, left: 0 });
  });

  it('labels what the policies say, and stays empty when they say nothing', () => {
    expect(reviewRequiredLabel(role())).toBe('Yes');
    expect(reviewRequiredLabel(notRequired)).toBe('No');
    expect(reviewRequiredLabel(role({ policies: 0, reviewRequired: null }))).toBeNull();
    expect(reviewRequiredLabel(role({ policies: 1, reviewRequired: null }))).toBeNull();
  });

  it('reads the toggle from a query string', () => {
    expect([true, 'true', 'TRUE'].map(isTrue)).toEqual([true, true, true]);
    expect([false, 'false', '', undefined, null, '1', 1].map(isTrue)).toEqual([false, false, false, false, false, false, false]);
  });

  it('reads per role whether any policy requires a review', () => {
    expect(ROLE_REVIEW_SQL).toContain('bool_or(p."hasAccessReview") AS "reviewRequired"');
    expect(ROLE_REVIEW_SQL).toContain('LEFT JOIN policies pol ON pol."resourceId" = roles.id');
  });

  it('runs: leaves the not-required role out with a notice, and shows it when switched on', async () => {
    query.mockResolvedValue({ rows: [role({ displayName: 'Board', reviews: 0, policies: 1, reviewRequired: false }), role()] });
    const off = await report.run({}, {});
    expect(off.rows.map(r => r.businessRole)).toEqual(['Finance clerk']);
    expect(off.notices.at(-1).text).toMatch(/^1 business role\(s\) left out because none of their policies requires/);

    const on = await report.run({ includeNotRequired: 'true' }, {});
    expect(on.rows.map(r => [r.businessRole, r.reviewRequired])).toEqual([['Board', 'No'], ['Finance clerk', 'Yes']]);
    expect(on.notices.some(n => /left out/.test(n.text))).toBe(false);
  });
});

describe('isNewRole', () => {
  it('rejects an unparseable date rather than calling it new', () => {
    expect(isNewRole('not a date', 90, NOW)).toBe(false);
    expect(isNewRole(daysAgo(10), 90, NOW)).toBe(true);
  });
});

describe('share', () => {
  it('rounds to a whole percent and is null with nothing to divide', () => {
    expect(share(1, 3)).toBe(33);
    expect(share(2, 3)).toBe(67);
    expect(share(0, 0)).toBeNull();
  });
});

describe('buildRow', () => {
  it('carries the numbers the status was read from, with dates as days', () => {
    const row = buildRow(role({ latestByPerson: 3 }), OPTIONS);
    expect(row).toEqual({
      businessRole: 'Finance clerk',
      systemName: 'Entra ID',
      status: STATUS.LATEST_PARTLY,
      reviewRequired: 'Yes',
      lastHumanReview: daysAgo(30).slice(0, 10),
      daysSinceHumanReview: 30,
      lastHumanReviewer: 'Ann Manager',
      members: 12,
      reviews: 3,
      humanReviews: 2,
      latestReviewEnd: daysAgo(20).slice(0, 10),
      latestReviewDecisions: 4,
      latestReviewByPerson: 3,
      latestReviewNotByPerson: 1,
      latestReviewByPersonShare: 75,
      defaultDecision: 'Approve',
      roleCreated: daysAgo(800).slice(0, 10),
      _entity: { kind: 'access-package', id: 'br-1' },
    });
    for (const col of report.columns) expect(row, col.key).toHaveProperty(col.key);
  });

  it('leaves the latest-round numbers empty, not zero, for a role with no round', () => {
    const row = buildRow(role({
      reviews: 0, humanReviews: 0, lastHumanAt: null, latestEndsAt: null, latestStatus: null,
      latestDecisions: null, latestByPerson: null, defaultDecision: null, lastHumanReviewer: null,
      systemName: undefined, createdDateTime: null, members: undefined,
    }), OPTIONS);
    expect(row).toMatchObject({
      status: STATUS.NO_REVIEW, lastHumanReview: null, daysSinceHumanReview: null, latestReviewEnd: null,
      latestReviewDecisions: null, latestReviewByPerson: null, latestReviewNotByPerson: null,
      latestReviewByPersonShare: null, systemName: null, roleCreated: null, members: 0,
    });
  });

  it('reads a missing by-person count in a held round as zero', () => {
    const row = buildRow(role({ latestByPerson: null, humanReviews: 0, lastHumanAt: null }), OPTIONS);
    expect(row.latestReviewByPerson).toBe(0);
    expect(row.latestReviewNotByPerson).toBe(4);
    expect(row.latestReviewByPersonShare).toBe(0);
  });
});

describe('compareRows', () => {
  const r = (status, lastHumanReview, businessRole) => ({ status, lastHumanReview, businessRole });

  it('puts the worst status first, then the longest-ago review, never-reviewed ahead of any date, then the name', () => {
    const rows = [
      r(STATUS.REVIEWED, '2026-09-01', 'A'),
      r(STATUS.LATEST_NOT_BY_PERSON, '2025-06-01', 'B'),
      r(STATUS.LATEST_NOT_BY_PERSON, '2024-01-01', 'C'),
      r(STATUS.NO_REVIEW, null, 'Zeta'),
      r(STATUS.NO_REVIEW, null, 'Alpha'),
      r(STATUS.NEW, null, 'D'),
      r(STATUS.LATEST_NOT_BY_PERSON, null, 'E'),
    ].sort(compareRows);
    expect(rows.map(x => x.businessRole)).toEqual(['Alpha', 'Zeta', 'E', 'C', 'B', 'A', 'D']);
  });

  it('orders every status, and colours every one', () => {
    expect(new Set(STATUS_ORDER)).toEqual(new Set(Object.values(STATUS)));
    expect(Object.keys(STATUS_COLORS).sort()).toEqual([...STATUS_ORDER].sort());
  });
});

describe('summaries', () => {
  it('counts each category and states the rule, with the thresholds used', () => {
    const rows = [
      { status: STATUS.REVIEWED, reviews: 2 }, { status: STATUS.REVIEWED, reviews: 1 },
      { status: STATUS.NEVER_BY_PERSON, reviews: 4 }, { status: STATUS.NO_REVIEW, reviews: 0 },
      { status: STATUS.NEW, reviews: 0 },
    ];
    const notices = summaries(rows, [{ createdDateTime: '2026-01-01' }], { newRoleDays: 30, staleAfterDays: 180 });
    expect(notices).toHaveLength(2);
    expect(notices[0].text).toBe('5 business role(s): 2 reviewed by a person in the latest round (40%), '
      + '1 never reviewed by a person, 1 never reviewed at all, 1 new (under 30 days).');
    expect(notices[1].text).toContain('more than 180 days');
  });

  it('warns when no decision was synced at all, and when no role carries a creation date', () => {
    const notices = summaries([{ status: STATUS.NO_REVIEW, reviews: 0 }], [{ createdDateTime: null }], OPTIONS);
    expect(notices.map(n => n.severity)).toEqual(['info', 'info', 'warning', 'info']);
    expect(notices[2].text).toContain('AccessReview.Read.All');
    expect(notices[3].text).toContain('creation date');
  });

  it('says so plainly when there are no business roles', () => {
    expect(summaries([], [], OPTIONS)).toEqual([{ severity: 'info', text: 'No business roles have been synced yet.' }]);
  });
});

describe('the template', () => {
  it('declares a list with two optional day thresholds, pivots and pies over its own columns', () => {
    expect(report).toMatchObject({ name: 'access-review-adoption', form: 'list' });
    expect(report.parametersSchema.required).toEqual([]);
    expect(Object.keys(report.parametersSchema.properties)).toEqual(['newRoleDays', 'staleAfterDays', 'includeNotRequired']);
    const keys = new Set(report.columns.map(c => c.key));
    for (const p of report.pivots) for (const k of [...p.rows, ...p.values]) expect(keys.has(k), k).toBe(true);
    for (const c of report.charts) {
      expect(keys.has(c.category)).toBe(true);
      if (c.value) expect(keys.has(c.value)).toBe(true);
    }
  });

  it('judges human decisions in the one query, per round, against business roles only', () => {
    expect(ROLE_REVIEW_SQL).toContain(`r."resourceType" = 'BusinessRole'`);
    expect(ROLE_REVIEW_SQL).toContain('r."deletedAt" IS NULL');
    expect(ROLE_REVIEW_SQL).toMatch(/AS human/);
    expect(ROLE_REVIEW_SQL).toContain('COUNT(*) FILTER (WHERE human)');
    expect(ROLE_REVIEW_SQL).toContain('COUNT(DISTINCT COALESCE(ra."principalId", ra."identityId"))');
  });

  it('runs: classifies, sorts worst first, and falls back to the default thresholds on junk', async () => {
    query.mockResolvedValue({
      rows: [
        role({ id: 'ok', displayName: 'Ok role' }),
        role({ id: 'never', displayName: 'Never role', humanReviews: 0, lastHumanAt: null, latestByPerson: 0 }),
        // 200 days old with no review: "New" only if the threshold were raised.
        role({ id: 'young', displayName: 'Young role', reviews: 0, createdDateTime: new Date(Date.now() - 200 * 86400000).toISOString() }),
      ],
    });
    const log = vi.fn();
    const { rows, notices } = await report.run({ newRoleDays: 'abc', staleAfterDays: '-3' }, { log });
    expect(rows.map(r => [r.businessRole, r.status])).toEqual([
      ['Young role', STATUS.NO_REVIEW],
      ['Never role', STATUS.NEVER_BY_PERSON],
      ['Ok role', STATUS.REVIEWED],
    ]);
    expect(notices[1].text).toContain('more than 365 days');
    expect(log).toHaveBeenCalledWith('access-review-adoption report: 3 business role(s), 0 left out');
  });

  it('honours the thresholds it is given', async () => {
    query.mockResolvedValue({
      rows: [role({ reviews: 0, createdDateTime: new Date(Date.now() - 200 * 86400000).toISOString() })],
    });
    const { rows } = await report.run({ newRoleDays: '365' }, undefined);
    expect(rows[0].status).toBe(STATUS.NEW);
  });
});
