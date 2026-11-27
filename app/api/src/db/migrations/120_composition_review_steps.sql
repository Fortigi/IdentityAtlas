-- 120: a composition review is a set of judged steps, not a note and a tick
--
-- Migration 116 kept a review as free notes plus a "signedOff" tick, which read
-- as "it is all fine". A review now walks through steps, and the reviewer gives
-- each one a verdict:
--
--   ownership   who is Accountable and Responsible for the role
--   lifecycle   how people get, keep and lose the role
--   contents    the permissions the role contains
--
--   good            nothing to change
--   needsChange     something should change: "remark" says what, and on the
--                   ownership step "proposal" may name the people it should be
--   notUnderstood   the reviewer cannot judge what they read: "remark" may hold
--                   their question
--
-- One row per judged step. The steps a review has ARE the steps that were asked,
-- so a later campaign that asks only some of them needs nothing more here.
-- Finishing a review is not agreeing with the role: a review with findings is
-- still a review. Its outcome (no findings, or findings) is read from its steps.
--
-- "proposal" is a proposal only — a review changes nothing. It holds the owners
-- as the reviewer says they should be, each picked from the directory:
--   { "accountable": { "principalId" | "identityId", "displayName" } | null,
--     "responsible": [ { "principalId" | "identityId", "displayName" } ] }
--
-- The feature is experimental (flag compositionReview): the reviews saved in the
-- old shape are removed rather than converted, as a tick says nothing per step.

DELETE FROM "BusinessRoleCompositionReviews";

ALTER TABLE "BusinessRoleCompositionReviews" DROP CONSTRAINT "ck_BusinessRoleCompositionReviews_says_something";
ALTER TABLE "BusinessRoleCompositionReviews" DROP COLUMN "signedOff";

CREATE TABLE "BusinessRoleCompositionReviewSteps" (
    "id"       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "reviewId" UUID NOT NULL REFERENCES "BusinessRoleCompositionReviews"("id") ON DELETE CASCADE,
    "step"     TEXT NOT NULL,
    "verdict"  TEXT NOT NULL,
    "remark"   TEXT NOT NULL DEFAULT '',
    "proposal" JSONB,
    CONSTRAINT "uq_BusinessRoleCompositionReviewSteps_step" UNIQUE ("reviewId", "step"),
    CONSTRAINT "ck_BusinessRoleCompositionReviewSteps_step" CHECK ("step" IN ('ownership', 'lifecycle', 'contents')),
    CONSTRAINT "ck_BusinessRoleCompositionReviewSteps_verdict" CHECK ("verdict" IN ('good', 'needsChange', 'notUnderstood')),
    CONSTRAINT "ck_BusinessRoleCompositionReviewSteps_proposal" CHECK (
        "proposal" IS NULL
        OR (jsonb_typeof("proposal") = 'object' AND "step" = 'ownership' AND "verdict" = 'needsChange')),
    CONSTRAINT "ck_BusinessRoleCompositionReviewSteps_says_what" CHECK (
        "verdict" <> 'needsChange' OR btrim("remark") <> '' OR "proposal" IS NOT NULL)
);
