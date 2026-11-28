-- 121: review campaigns
--
-- A campaign asks the people who answer for a set of business roles to review
-- them (the composition review of migrations 116 and 120): which steps, which
-- roles, and when — once, or again every so many months.
--
--   ReviewCampaigns         what is asked: the steps, who is asked ("askedRoles",
--                           today only the Accountable; both JSON arrays), the first day, the
--                           interval (NULL = once) and how many days a round has
--   ReviewCampaignScopes    which roles: a business role by itself ("resourceId")
--                           or every role in a role portfolio ("contextId", a
--                           Catalog context). A portfolio is read again at the
--                           start of each round, so a role added to it joins the
--                           next round
--   ReviewCampaignRounds    one round of asking: its start and the day it is due
--   ReviewCampaignRequests  one role to review in one round. "reviewId" is the
--                           review that answered it; NULL while it waits
--
-- Who is asked is not stored: it is whoever is Accountable for the role at the
-- moment of looking (BusinessRoleOwners), so a new Accountable inherits the
-- request, and a role with nobody Accountable shows as having nobody to ask.
-- Whether a request waits, is late or was answered is read from "reviewId" and
-- the round's "dueAt"; a request of an earlier round that was never answered
-- stays as the record that it was missed.
--
-- "reviewKind" names what a campaign reviews. Only business role composition
-- exists; the column is there so org units and applications can follow without
-- a second set of tables.
--
-- Experimental, under the compositionReview flag. Nothing here grants access.

CREATE TABLE "ReviewCampaigns" (
    "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "name"           TEXT NOT NULL,
    "reviewKind"     TEXT NOT NULL DEFAULT 'BusinessRoleComposition',
    "steps"          JSONB NOT NULL,
    "askedRoles"     JSONB NOT NULL DEFAULT '["Accountable"]'::jsonb,
    "startsOn"       DATE NOT NULL,
    "intervalMonths" INTEGER,
    "dueDays"        INTEGER NOT NULL,
    "endedAt"        TIMESTAMPTZ,
    "createdBy"      TEXT NOT NULL,
    "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "ck_ReviewCampaigns_name" CHECK (btrim("name") <> ''),
    CONSTRAINT "ck_ReviewCampaigns_kind" CHECK ("reviewKind" IN ('BusinessRoleComposition')),
    CONSTRAINT "ck_ReviewCampaigns_steps" CHECK (jsonb_typeof("steps") = 'array' AND jsonb_array_length("steps") >= 1 AND "steps" <@ '["ownership", "lifecycle", "contents"]'::jsonb),
    CONSTRAINT "ck_ReviewCampaigns_asked" CHECK (jsonb_typeof("askedRoles") = 'array' AND jsonb_array_length("askedRoles") >= 1 AND "askedRoles" <@ '["Accountable"]'::jsonb),
    CONSTRAINT "ck_ReviewCampaigns_interval" CHECK ("intervalMonths" IS NULL OR "intervalMonths" IN (1, 3, 6, 12)),
    CONSTRAINT "ck_ReviewCampaigns_due" CHECK ("dueDays" BETWEEN 1 AND 365)
);

CREATE TABLE "ReviewCampaignScopes" (
    "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "campaignId" UUID NOT NULL REFERENCES "ReviewCampaigns"("id") ON DELETE CASCADE,
    "resourceId" UUID REFERENCES "Resources"("id") ON DELETE CASCADE,
    "contextId"  UUID REFERENCES "Contexts"("id") ON DELETE CASCADE,
    CONSTRAINT "ck_ReviewCampaignScopes_one" CHECK (num_nonnulls("resourceId", "contextId") = 1)
);
CREATE UNIQUE INDEX "uq_ReviewCampaignScopes_role" ON "ReviewCampaignScopes" ("campaignId", "resourceId") WHERE "resourceId" IS NOT NULL;
CREATE UNIQUE INDEX "uq_ReviewCampaignScopes_portfolio" ON "ReviewCampaignScopes" ("campaignId", "contextId") WHERE "contextId" IS NOT NULL;

CREATE TABLE "ReviewCampaignRounds" (
    "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "campaignId" UUID NOT NULL REFERENCES "ReviewCampaigns"("id") ON DELETE CASCADE,
    "number"     INTEGER NOT NULL,
    "startsAt"   TIMESTAMPTZ NOT NULL,
    "dueAt"      TIMESTAMPTZ NOT NULL,
    CONSTRAINT "uq_ReviewCampaignRounds_number" UNIQUE ("campaignId", "number"),
    CONSTRAINT "ck_ReviewCampaignRounds_number" CHECK ("number" >= 1)
);

CREATE TABLE "ReviewCampaignRequests" (
    "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "roundId"    UUID NOT NULL REFERENCES "ReviewCampaignRounds"("id") ON DELETE CASCADE,
    "resourceId" UUID NOT NULL REFERENCES "Resources"("id") ON DELETE CASCADE,
    "reviewId"   UUID REFERENCES "BusinessRoleCompositionReviews"("id") ON DELETE SET NULL,
    CONSTRAINT "uq_ReviewCampaignRequests_role" UNIQUE ("roundId", "resourceId")
);
CREATE INDEX "ix_ReviewCampaignRequests_role" ON "ReviewCampaignRequests" ("resourceId") WHERE "reviewId" IS NULL;
