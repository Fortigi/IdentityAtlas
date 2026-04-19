-- Read-only API keys for downstream tooling (Excel Power Query, BI tools, etc).
--
-- The existing crawler API keys (`fgc_…`) are only honoured by the
-- crawlerAuthMiddleware on /api/ingest and /api/crawlers/* routes — they do
-- NOT satisfy the JWT-based authMiddleware that guards the read API
-- (/api/users, /api/resources, etc). For a Power-Query workbook to refresh
-- against an auth-on deployment we need a credential that survives without a
-- signed-in user. This table stores those credentials.
--
-- Format: tokens are issued as `fgr_<32-byte url-safe base64>`. Only the
-- SHA-256 hash is stored; the plaintext is shown to the operator exactly once
-- at creation time. Lookup by hash, never by id, so a stolen DB row can't be
-- replayed against the API.

CREATE TABLE IF NOT EXISTS "ReadApiKeys" (
    "id"           SERIAL PRIMARY KEY,
    "name"         TEXT NOT NULL,
    "tokenHash"    TEXT NOT NULL UNIQUE,
    "tokenPrefix"  TEXT NOT NULL,                       -- first 12 chars of plaintext, for display
    "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
    "createdBy"    TEXT,
    "lastUsedAt"   TIMESTAMPTZ,
    "expiresAt"    TIMESTAMPTZ,                         -- NULL = no expiry
    "revoked"      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS "ix_ReadApiKeys_tokenHash"
    ON "ReadApiKeys" ("tokenHash")
    WHERE "revoked" = FALSE;
