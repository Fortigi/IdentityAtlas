// The newest review of each business role and how it went, one definition for
// the Business Roles list and a unit's team overview. Same logic as
// governance.js LAST_REVIEW_CTE: take the role's newest review instance, then
// derive a status from that instance's decisions (Compliant / In Progress /
// Missed / Reviewed Late). Only usable when "CertificationDecisions" exists.

// `roleFilter` narrows the instances read, e.g. to a set of roles; empty reads all.
export const lastReviewCtes = (roleFilter = '') => `"LatestInstance" AS (
        SELECT DISTINCT ON ("resourceId")
               "resourceId",
               "reviewInstanceId",
               "reviewInstanceEndDateTime"
          FROM "CertificationDecisions"
         ${roleFilter}
         ORDER BY "resourceId", "reviewInstanceEndDateTime" DESC NULLS LAST
      ), "LastReviewPerAP" AS (
        SELECT li."resourceId",
               li."reviewInstanceEndDateTime" AS deadline,
               MAX(CASE WHEN d.decision <> 'NotReviewed' THEN d."reviewedDateTime" END)      AS "lastReviewDate",
               MAX(CASE WHEN d.decision <> 'NotReviewed' THEN d."reviewedByDisplayName" END) AS "lastReviewedBy",
               CASE
                 WHEN SUM(CASE WHEN d.decision = 'NotReviewed' THEN 1 ELSE 0 END) = 0
                  AND SUM(CASE WHEN d.decision <> 'NotReviewed' AND d."reviewedDateTime"::date > li."reviewInstanceEndDateTime"::date THEN 1 ELSE 0 END) = 0
                   THEN 'Compliant'
                 WHEN SUM(CASE WHEN d.decision = 'NotReviewed' THEN 1 ELSE 0 END) > 0
                  AND li."reviewInstanceEndDateTime"::date >= current_date
                   THEN 'In Progress'
                 WHEN SUM(CASE WHEN d.decision = 'NotReviewed' THEN 1 ELSE 0 END) > 0
                  AND li."reviewInstanceEndDateTime"::date < current_date
                   THEN 'Missed'
                 ELSE 'Reviewed Late'
               END AS "complianceStatus",
               CASE
                 WHEN li."reviewInstanceEndDateTime"::date < current_date
                   THEN (current_date - li."reviewInstanceEndDateTime"::date)
                 ELSE 0
               END AS "daysOverdue"
          FROM "LatestInstance" li
          INNER JOIN "CertificationDecisions" d
            ON d."resourceId" = li."resourceId"
           AND d."reviewInstanceId" = li."reviewInstanceId"
         GROUP BY li."resourceId", li."reviewInstanceEndDateTime"
      )`;

// The review of each of these roles ($1 uuid[]).
export const ROLE_REVIEW_SQL = `
    WITH ${lastReviewCtes('WHERE "resourceId" = ANY($1::uuid[])')}
    SELECT "resourceId", "complianceStatus", deadline AS "reviewDeadline", "daysOverdue"
      FROM "LastReviewPerAP"`;

/** resourceId → { complianceStatus, reviewDeadline, daysOverdue }. Pure. */
export function roleReviews(rows) {
  return new Map(rows.map(r => [r.resourceId, {
    complianceStatus: r.complianceStatus ?? null,
    reviewDeadline: r.reviewDeadline ?? null,
    daysOverdue: r.daysOverdue ?? 0,
  }]));
}
