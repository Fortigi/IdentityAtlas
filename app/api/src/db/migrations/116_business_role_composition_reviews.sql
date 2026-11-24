-- 116: composition reviews of a business role
--
-- Somebody reads what a business role contains, writes down what they think
-- and, when they agree with it, signs it off. Every save is a row of its own,
-- so the history of who said what, and when, stays. Rows are never updated.
--
-- "composition" is what the role contained at that moment (the live resources
-- it Contains, as [{ id, displayName }]), so a sign-off says what was signed
-- off, and the page can tell what changed since.
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
    "composition"    JSONB NOT NULL DEFAULT '[]'::jsonb,
    CONSTRAINT "ck_BusinessRoleCompositionReviews_says_something" CHECK ("signedOff" OR btrim("notes") <> '')
);
CREATE INDEX "ix_BusinessRoleCompositionReviews_role" ON "BusinessRoleCompositionReviews" ("resourceId", "reviewedAt" DESC);
