-- Migration 119: which source an identity belongs to (#1510).
--
-- "Identities" had no owner column, so the ingest could not tell one source's
-- people from another's: a full identities sync compared the WHOLE table against
-- its own batch and deleted every identity it had not sent — an upload, a CSV
-- import, another crawler's, account linking's. (A CSV run with identities in
-- more than one system even deleted its own earlier batches.)
--
-- Principals and Resources solve this with a systemId, and so does this: the
-- ingest stamps the envelope system on every record of a table that has the
-- column, and the full-sync reconcile is then bounded to `systemId = <sender>`.
--
-- Nullable, and NOT backfilled. A NULL row is one no sync has claimed yet: every
-- existing identity, and anything account linking or an upload creates. The
-- reconcile's equality predicate never matches NULL, so those rows are outside
-- every crawler's delete; a source claims its own the next time it sends them.
-- A backfill from the linked accounts would guess wrong exactly where this bug
-- bites: an HR source's people are linked to Entra accounts, and stamping them
-- Entra's would let the Entra sync delete them.
--
-- ON DELETE SET NULL, not CASCADE: removing a system must not take people with
-- it — an identity may hold accounts of other systems. Its rows simply become
-- unclaimed again.

ALTER TABLE "Identities" ADD COLUMN IF NOT EXISTS "systemId" INTEGER;

ALTER TABLE "Identities" DROP CONSTRAINT IF EXISTS "fk_Identities_systemId";
ALTER TABLE "Identities" ADD CONSTRAINT "fk_Identities_systemId"
    FOREIGN KEY ("systemId") REFERENCES "Systems"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "ix_Identities_systemId" ON "Identities"("systemId");
