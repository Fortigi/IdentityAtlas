// Unit tests for the "decided by a person" rule.
//
// The SQL is a string, so its correctness against real rows is the contract
// test's job; here the assertions pin each clause of the rule, because dropping
// any one of them silently counts the platform's auto-applied decisions as
// human — the exact error the adoption reports exist to avoid.

import { describe, it, expect } from 'vitest';
import {
  APPROVAL_VALUES, DENIAL_VALUES, NON_DECISION_VALUES, SYSTEM_REVIEWER_ID,
  approvalSql, denialSql, humanDecisionSql, reviewRoundKeySql, reviewRoundOpen,
} from './humanReview.js';

describe('humanDecisionSql', () => {
  const sql = humanDecisionSql('x');

  it('excludes every "nobody answered" value of every source', () => {
    expect(NON_DECISION_VALUES).toEqual(['NotReviewed', 'NotNotified', 'NoDecision', 'NoResponse']);
    expect(sql).toContain(`x.decision NOT IN ('NotReviewed', 'NotNotified', 'NoDecision', 'NoResponse')`);
    expect(sql).toContain('x.decision IS NOT NULL');
  });

  it("excludes the platform's own reviewer, by id and by name", () => {
    expect(SYSTEM_REVIEWER_ID).toBe('00000000-0000-0000-0000-000000000000');
    expect(sql).toContain(`COALESCE(x."reviewedBy" <> '00000000-0000-0000-0000-000000000000'::uuid, TRUE)`);
    expect(sql).toContain(`COALESCE(x."reviewedByDisplayName", '') NOT ILIKE '%access reviews%'`);
  });

  it('requires a reviewer to be recorded at all — an id or a name', () => {
    expect(sql).toContain(`(x."reviewedBy" IS NOT NULL OR COALESCE(x."reviewedByDisplayName", '') <> '')`);
  });

  it('uses the alias it is given, and d by default', () => {
    expect(humanDecisionSql()).toContain('d.decision');
    expect(sql).not.toMatch(/\bd\./);
  });
});

describe('approval and denial', () => {
  it('cover the approve and deny words of every source, and do not overlap', () => {
    expect(approvalSql('y')).toBe(`y.decision IN ('Approve', 'Approved', 'Certify')`);
    expect(denialSql('y')).toBe(`y.decision IN ('Deny', 'Denied', 'Revoke', 'Reduce')`);
    expect(APPROVAL_VALUES.filter(v => DENIAL_VALUES.includes(v))).toEqual([]);
  });
});

describe('reviewRoundKeySql', () => {
  it('prefers the instance id, then the midPoint campaign, then one round per role', () => {
    expect(reviewRoundKeySql('z')).toBe(
      `COALESCE(z."reviewInstanceId"::text, z."extendedAttributes"->>'campaignOid', '')`);
  });
});

describe('reviewRoundOpen', () => {
  const now = new Date('2026-10-22T12:00:00Z');

  it('is open while the end date is still ahead, whatever the status says', () => {
    expect(reviewRoundOpen({ endsAt: '2026-10-23T00:00:00Z', status: 'Completed' }, now)).toBe(true);
  });

  it('is closed once the end date has passed and the status does not say otherwise', () => {
    expect(reviewRoundOpen({ endsAt: '2026-10-21T00:00:00Z', status: 'Completed' }, now)).toBe(false);
    expect(reviewRoundOpen({ endsAt: '2026-10-22T12:00:00Z', status: 'Applied' }, now)).toBe(false);
  });

  it.each(['InProgress', 'notstarted', 'Initializing', 'active', 'open', 'in progress'])(
    'is open while the status is %s, even past its end date', (status) => {
      expect(reviewRoundOpen({ endsAt: '2026-01-01T00:00:00Z', status }, now)).toBe(true);
    });

  it('treats a round with no end date and no telling status as finished', () => {
    expect(reviewRoundOpen({ endsAt: null, status: null }, now)).toBe(false);
    expect(reviewRoundOpen({}, now)).toBe(false);
  });

  it('defaults the clock to now', () => {
    expect(reviewRoundOpen({ endsAt: '2999-01-01T00:00:00Z' })).toBe(true);
    expect(reviewRoundOpen({ endsAt: '2000-01-01T00:00:00Z' })).toBe(false);
  });
});
