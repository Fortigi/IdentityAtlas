-- 113: what an assignment policy says about how access is gained and lost
--
-- A business role can be gained in more than one way (a rule, a request, an
-- administrator's assignment) and lost in more than one way (a rule, a review,
-- an expiry, a removal request). "AssignmentPolicies" held only the rule and
-- review flags, so a role could not say which of these applied, and the rule
-- itself was never stored.
--
-- A column stays NULL when the source does not say: "not stated" and "no" are
-- different answers, and the first one is shown as Unknown.
--
--   "allowsRequest"           someone can request it (for themselves or another)
--   "allowsDirectAssignment"  it is handed out by an administrator
--   "allowsRemovalRequest"    someone can request its removal
--   "requiresApproval"        a request needs approval
--   "hasExpiration"           an assignment ends by itself
--   "expiration"              the source's expiry settings
--   "targetRule"              the rule's text, as the source writes it

ALTER TABLE "AssignmentPolicies" ADD COLUMN IF NOT EXISTS "allowsRequest"          BOOLEAN;
ALTER TABLE "AssignmentPolicies" ADD COLUMN IF NOT EXISTS "allowsDirectAssignment" BOOLEAN;
ALTER TABLE "AssignmentPolicies" ADD COLUMN IF NOT EXISTS "allowsRemovalRequest"   BOOLEAN;
ALTER TABLE "AssignmentPolicies" ADD COLUMN IF NOT EXISTS "requiresApproval"       BOOLEAN;
ALTER TABLE "AssignmentPolicies" ADD COLUMN IF NOT EXISTS "hasExpiration"          BOOLEAN;
ALTER TABLE "AssignmentPolicies" ADD COLUMN IF NOT EXISTS "expiration"             JSONB;
ALTER TABLE "AssignmentPolicies" ADD COLUMN IF NOT EXISTS "targetRule"             TEXT;

-- The Entra crawler has always stored requestorSettings as "policyConditions",
-- so existing policies can answer the request questions before their next sync.
-- Only rows that carry those settings: another source's policy stays NULL.
UPDATE "AssignmentPolicies"
   SET "allowsRequest" = COALESCE(("policyConditions"->>'enableTargetsToSelfAddAccess')::boolean, FALSE)
                      OR COALESCE(("policyConditions"->>'enableOnBehalfRequestorsToAddAccess')::boolean, FALSE),
       "allowsRemovalRequest" = COALESCE(("policyConditions"->>'enableTargetsToSelfRemoveAccess')::boolean, FALSE)
                             OR COALESCE(("policyConditions"->>'enableOnBehalfRequestorsToRemoveAccess')::boolean, FALSE),
       "allowsDirectAssignment" = ("allowedTargetScope" = 'notSpecified')
 WHERE jsonb_typeof("policyConditions") = 'object'
   AND "policyConditions" ? 'enableTargetsToSelfAddAccess';
