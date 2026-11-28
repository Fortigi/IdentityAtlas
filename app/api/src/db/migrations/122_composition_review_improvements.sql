-- Migration 122: a fourth step of the composition review — improvements.
--
-- Role mining suggests what would make the business role better (a permission
-- every holder has and nobody else, or a rule that would hand the role out by
-- itself), only when it is 95% sure (lib/roleImprovements.js). The reviewer
-- decides on each suggestion; the step stores the suggestions as they were
-- shown with those decisions, in "proposal" as
--   { suggestions: [{ key, kind, confidence, ..., decision }], declinedBefore, since }
-- whatever the verdict: a declined suggestion is recorded, so the next review
-- does not ask it again. A campaign may ask this step like the others.

ALTER TABLE "BusinessRoleCompositionReviewSteps" DROP CONSTRAINT "ck_BusinessRoleCompositionReviewSteps_step";
ALTER TABLE "BusinessRoleCompositionReviewSteps" ADD CONSTRAINT "ck_BusinessRoleCompositionReviewSteps_step"
    CHECK ("step" IN ('ownership', 'lifecycle', 'contents', 'improvements'));

ALTER TABLE "BusinessRoleCompositionReviewSteps" DROP CONSTRAINT "ck_BusinessRoleCompositionReviewSteps_proposal";
ALTER TABLE "BusinessRoleCompositionReviewSteps" ADD CONSTRAINT "ck_BusinessRoleCompositionReviewSteps_proposal" CHECK (
    "proposal" IS NULL
    OR (jsonb_typeof("proposal") = 'object' AND "step" = 'ownership' AND "verdict" = 'needsChange')
    OR (jsonb_typeof("proposal") = 'object' AND "step" = 'improvements' AND jsonb_typeof("proposal"->'suggestions') = 'array'));

ALTER TABLE "ReviewCampaigns" DROP CONSTRAINT "ck_ReviewCampaigns_steps";
ALTER TABLE "ReviewCampaigns" ADD CONSTRAINT "ck_ReviewCampaigns_steps"
    CHECK (jsonb_typeof("steps") = 'array' AND jsonb_array_length("steps") >= 1 AND "steps" <@ '["ownership", "lifecycle", "contents", "improvements"]'::jsonb);
