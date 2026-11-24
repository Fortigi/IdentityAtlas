import { describe, it, expect } from 'vitest';
import { lastReviewCtes, ROLE_REVIEW_SQL, roleReviews } from './businessRoleReview.js';

describe('lastReviewCtes', () => {
  it('reads every role when given no filter, and only the given ones with one', () => {
    expect(lastReviewCtes()).not.toContain('ANY(');
    expect(lastReviewCtes('WHERE "resourceId" = ANY($1::uuid[])')).toMatch(/FROM "CertificationDecisions"\s+WHERE "resourceId" = ANY\(\$1::uuid\[\]\)\s+ORDER BY/);
  });

  it('takes the newest instance of each role', () => {
    expect(lastReviewCtes()).toContain('DISTINCT ON ("resourceId")');
    expect(lastReviewCtes()).toContain('ORDER BY "resourceId", "reviewInstanceEndDateTime" DESC NULLS LAST');
  });
});

describe('ROLE_REVIEW_SQL', () => {
  it('reads the review of the given roles only', () => {
    expect(ROLE_REVIEW_SQL).toContain('ANY($1::uuid[])');
    expect(ROLE_REVIEW_SQL).toContain('deadline AS "reviewDeadline"');
  });
});

describe('roleReviews', () => {
  it('keys each review by role and fills what the row leaves out', () => {
    const map = roleReviews([
      { resourceId: 'r1', complianceStatus: 'Missed', reviewDeadline: '2026-10-01', daysOverdue: 54 },
      { resourceId: 'r2' },
    ]);
    expect(map.get('r1')).toEqual({ complianceStatus: 'Missed', reviewDeadline: '2026-10-01', daysOverdue: 54 });
    expect(map.get('r2')).toEqual({ complianceStatus: null, reviewDeadline: null, daysOverdue: 0 });
  });
});
