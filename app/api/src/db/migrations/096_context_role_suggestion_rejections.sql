-- Identity Atlas — Rejected role suggestions (template UI, option A)
--
-- The detail page of an organizational unit or a logical application suggests
-- an Accountable when it has none: the manager of most of its members, or the
-- owner of most of its resources. An analyst can reject that suggestion; the
-- rejection is remembered here so the same candidate is never suggested again
-- for that context. Design: docs/architecture/template-ui.md §2.
--
-- INTERIM: this table holds a judgement about a person and a context, which is
-- what claims (POC step 2) will model. When claims land, these rows move into
-- them and this table goes.

CREATE TABLE "ContextRoleSuggestionRejections" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "contextId"   UUID NOT NULL REFERENCES "Contexts"("id")   ON DELETE CASCADE,
    "principalId" UUID          REFERENCES "Principals"("id") ON DELETE CASCADE,
    "identityId"  UUID          REFERENCES "Identities"("id") ON DELETE CASCADE,
    "role"        TEXT NOT NULL CHECK ("role" IN ('Accountable', 'Responsible')),
    "rejectedBy"  TEXT,
    "rejectedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "ck_ContextRoleSuggestionRejections_one_holder" CHECK (("principalId" IS NULL) <> ("identityId" IS NULL))
);
CREATE UNIQUE INDEX "ux_ContextRoleSuggestionRejections_principal" ON "ContextRoleSuggestionRejections" ("contextId", "principalId", "role") WHERE "principalId" IS NOT NULL;
CREATE UNIQUE INDEX "ux_ContextRoleSuggestionRejections_identity"  ON "ContextRoleSuggestionRejections" ("contextId", "identityId",  "role") WHERE "identityId"  IS NOT NULL;
