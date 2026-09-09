-- Identity Atlas — named recipients for a matrix share (#1166)
--
-- A share is addressed to PEOPLE, not to whoever happens to hold the link.
-- Migration 061 made the token the only thing standing between a URL and the
-- view, which meant a forwarded link worked for anybody who could sign in.
-- This table is the actual gate: `resolve` opens the snapshot only for a
-- caller who is on the share's recipient list (or created it).
--
-- The row is a SNAPSHOT of the person, like the share itself is a snapshot of
-- the view. `principalId` links back to the directory entry the sharer picked,
-- but there is deliberately NO foreign key and the name/key are denormalised:
-- a crawler re-run that re-keys or removes a principal must not silently drop
-- someone from a share's audit record.
--
-- `userKey` is the lower-cased sign-in name (UPN / e-mail) the recipient will
-- authenticate with. It is matched case-insensitively against the token's
-- `email` / `upn` / `preferred_username` claims, and `principalId` against
-- `oid`, so a tenant that hands out any one of those still resolves.

CREATE TABLE "MatrixShareRecipients" (
    "id"          BIGSERIAL PRIMARY KEY,
    "shareId"     UUID NOT NULL REFERENCES "MatrixShares" ("id") ON DELETE CASCADE,
    "principalId" UUID,
    "userKey"     TEXT NOT NULL,
    "displayName" TEXT,
    "addedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "uq_MatrixShareRecipients_share_user" UNIQUE ("shareId", "userKey")
);

CREATE INDEX "ix_MatrixShareRecipients_shareId" ON "MatrixShareRecipients" ("shareId");

-- The resolve path looks a caller up by their sign-in name across every share
-- they might have been sent, so the key gets its own index.
CREATE INDEX "ix_MatrixShareRecipients_userKey" ON "MatrixShareRecipients" ("userKey");
