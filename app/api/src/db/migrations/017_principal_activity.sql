-- Per-principal activity snapshot.
--
-- Stores only the LATEST known activity per combination — no per-event
-- history. This table is intentionally NOT attached to the _history audit
-- triggers: daily crawls rewrite sign-in timestamps, and a history row
-- for every user/SP every day would dominate storage without
-- investigative value. Historical trend analysis belongs in a separate
-- time-series store (Azure Monitor, a data warehouse) — not here.
--
-- Two row shapes coexist in one table, distinguished by resourceId:
--
--   Aggregate per-principal (A):
--     resourceId = '00000000-0000-0000-0000-000000000000' (AGG_RESOURCE).
--     e.g. activityType='SignIn' for a user's four signInActivity
--     timestamps, or 'ServicePrincipalSignIn' for an SP's aggregate row
--     from /reports/servicePrincipalSignInActivities.
--
--   Per (principal, resource/app) pair (B):
--     resourceId = the "target app" the principal interacted with. This is
--     an intentionally loose reference — we don't enforce FK because the
--     target may be a Principal (service principal representing an Entra
--     app), a Resources row (group, directory role), or a deterministic
--     synthetic id we minted elsewhere. Callers are expected to know what
--     activityType their resourceId means.
--     activityType='SignInPerApp', derived from /auditLogs/signIns,
--     answering "when did user X last sign in to app Y?". For this type
--     resourceId = the SP's Principals.id (because SPs represent apps in
--     Entra).
--
-- Why a sentinel UUID instead of a nullable column:
--   The generic ingest upsert uses ON CONFLICT (keyColumns) which needs a
--   non-partial unique constraint. A simple composite PK covering the
--   sentinel rows and the real rows is far less special-casing than
--   teaching the ingest engine about partial indexes.
--
-- AGG_RESOURCE = '00000000-0000-0000-0000-000000000000'::uuid. Keep this
-- constant in sync with AGG_RESOURCE_ID in app/api/src/ingest/validation.js
-- and the crawler. No real Entra object has the all-zeroes UUID.

CREATE TABLE IF NOT EXISTS "PrincipalActivity" (
    "principalId"                      UUID NOT NULL,
    "resourceId"                       UUID NOT NULL
                                       DEFAULT '00000000-0000-0000-0000-000000000000',
    "activityType"                     TEXT NOT NULL,

    -- Sign-in timestamps. All optional because different sources fill in
    -- different subsets: the user signInActivity property populates the
    -- first three; the SP report also populates applicationAuth / delegated
    -- client variants via extendedAttributes below; audit logs aggregate
    -- whatever events were seen in the window.
    "lastSignInDateTime"               TIMESTAMPTZ,
    "lastNonInteractiveSignInDateTime" TIMESTAMPTZ,
    "lastSuccessfulSignInDateTime"     TIMESTAMPTZ,
    "lastFailedSignInDateTime"         TIMESTAMPTZ,

    -- Count of events seen across aggregation windows. Null for sources
    -- that don't give counts (Graph's signInActivity property is a
    -- timestamp-only summary).
    "signInCount"                      BIGINT,

    -- Source-specific overflow: SP report's two extra timestamp flavours,
    -- audit log status counts, etc. Not indexed; keeps the core schema
    -- stable across sources.
    "extendedAttributes"               JSONB,

    "updatedAt"                        TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY ("principalId", "resourceId", "activityType")
);

-- Access-pattern indexes. The risk engine queries by principalId with a
-- date filter (stale-account detection). The UI queries by resourceId
-- for "who signed in to this app recently" views.
CREATE INDEX IF NOT EXISTS "ix_PrincipalActivity_resource"
    ON "PrincipalActivity" ("resourceId")
    WHERE "resourceId" <> '00000000-0000-0000-0000-000000000000';

-- Cheap bookkeeping index: the audit-log crawler asks "when did we last
-- store a SignInPerApp row?" to compute the delta-fetch window.
CREATE INDEX IF NOT EXISTS "ix_PrincipalActivity_updatedAt"
    ON "PrincipalActivity" ("activityType", "updatedAt");
