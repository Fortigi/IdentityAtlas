-- Identity Atlas — matrix share links (#1166)
--
-- An analyst configures a matrix in the wizard and shares it with a business
-- user (a team manager, a resource owner) via a link. The share stores a
-- SNAPSHOT of the view-state at share time — the wizard filter, the managed
-- (All / Governed / Non-governed / Gaps) toggle and the display mode — so later
-- edits to the originating saved filter never silently change what the
-- recipient sees. The data behind the view stays live.
--
-- Only the SHA-256 hash of the share token is stored (the `ReadApiKeys`
-- pattern); the plaintext `fgs_…` token is shown to the sharer exactly once at
-- creation and travels in the URL fragment, which browsers never send to a
-- server.
--
-- `shareType` is a discriminator so a future shareable thing (a report, #1134)
-- plugs into the same store/token/resolve mechanism rather than growing a
-- second one. v1 only ever writes 'matrix'.
--
-- Revocation is a soft flag: usage history survives a revoke, which is what
-- makes the "shared but never used" clean-up view possible.

CREATE TABLE "MatrixShares" (
    "id"          UUID PRIMARY KEY,
    "shareType"   TEXT NOT NULL DEFAULT 'matrix',
    "name"        TEXT NOT NULL,
    "filter"      JSONB NOT NULL,
    "displayMode" TEXT,
    "managed"     TEXT,
    "tokenHash"   TEXT NOT NULL UNIQUE,
    "createdBy"   TEXT,
    "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    "revokedAt"   TIMESTAMPTZ,
    "revokedBy"   TEXT
);

CREATE INDEX "ix_MatrixShares_createdAt" ON "MatrixShares" ("createdAt" DESC);

-- Per-share, per-recipient usage. Every recipient is signed in, so "was this
-- link ever used, and by whom?" is answerable precisely. `userKey` is the
-- recipient's email / UPN / name, or 'anonymous' on an auth-disabled install.
CREATE TABLE "MatrixShareAccesses" (
    "id"            BIGSERIAL PRIMARY KEY,
    "shareId"       UUID NOT NULL REFERENCES "MatrixShares" ("id") ON DELETE CASCADE,
    "userKey"       TEXT NOT NULL,
    "firstAccessAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "lastAccessAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    "accessCount"   INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "uq_MatrixShareAccesses_share_user" UNIQUE ("shareId", "userKey")
);

CREATE INDEX "ix_MatrixShareAccesses_shareId" ON "MatrixShareAccesses" ("shareId");
