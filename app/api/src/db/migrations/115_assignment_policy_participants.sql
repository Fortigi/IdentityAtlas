-- 115: who approves, reviews and may request a business role, per policy
--
-- One JSON list per policy, written by the crawler on ingest/governance/policies:
--   [{ participation: Approver | Reviewer | Requestor,
--      subjectType: User | Group | Manager | Sponsor | Self | Everyone | Rule | Organization | Other,
--      principalId?, groupId?, rule?, managerLevel?, displayName?,
--      isFallback, onBehalf, stage }]
--
-- NULL means the source did not say, an empty list that nobody is named.

ALTER TABLE "AssignmentPolicies" ADD COLUMN IF NOT EXISTS "participants" JSONB;
