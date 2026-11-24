-- 116: composition reviews of a business role
--
-- A composition review is an object of its own, linked to the role it reviews:
-- somebody read what the role contained at a point in time, wrote notes and,
-- when they agreed with it, signed it off. Every save is a row of its own and
-- rows are never updated, so the history of who said what, and when, stays.
--
-- "snapshot" is the role as it was at that moment (lib/businessRoleSnapshot.js):
-- its name and catalog, its type and ways in and out, the resources it contained,
-- its assignment policies with their rules, who answered for it and how many
-- held it. A sign-off therefore says exactly what was signed off, and the page
-- can tell what changed since. It carries a "version" for later shapes.
--
-- Who: "reviewedBy" is the signed-in user's e-mail or user name (lib/userOf.js),
-- "reviewedByName" their display name when the token carries one.
--
-- Not access: nothing here is read as anyone holding anything.

CREATE TABLE "BusinessRoleCompositionReviews" (
    "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "resourceId"     UUID NOT NULL REFERENCES "Resources"("id") ON DELETE CASCADE,
    "notes"          TEXT NOT NULL DEFAULT '',
    "signedOff"      BOOLEAN NOT NULL DEFAULT false,
    "reviewedBy"     TEXT NOT NULL,
    "reviewedByName" TEXT,
    "reviewedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "snapshot"       JSONB NOT NULL,
    CONSTRAINT "ck_BusinessRoleCompositionReviews_says_something" CHECK ("signedOff" OR btrim("notes") <> ''),
    CONSTRAINT "ck_BusinessRoleCompositionReviews_snapshot" CHECK (jsonb_typeof("snapshot") = 'object')
);
CREATE INDEX "ix_BusinessRoleCompositionReviews_role" ON "BusinessRoleCompositionReviews" ("resourceId", "reviewedAt" DESC);
