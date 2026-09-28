-- Migration 076 — index "Principals"."externalId".
--
-- WHY
-- A Context's `ownerUserId` is free text: whatever the source system calls the
-- owner of that grouping. To show a person rather than an opaque string the
-- contexts read endpoints resolve it against "Principals"."externalId", once
-- per context row, in the query (routes/contexts/read.js).
--
-- "Principals" had indexes on systemId, principalType, email, employeeId,
-- contextId, managerId and deletedAt — but none on externalId, the column the
-- ingest itself keys every upsert on. So the resolution was one sequential scan
-- of the whole table per context: on the scale environment that is 183k rows,
-- and the contexts list asks for 1,500 of them.
--
-- WHAT
-- A partial index: a principal with no externalId can never be the answer to
-- "who is externalId X", so those rows are left out and the index stays small
-- on directories where synthesised accounts have no source key.
--
-- Not unique: two systems may legitimately use the same external id for
-- different accounts (that is why the ingest keys on (systemId, externalId)),
-- and the owner lookup breaks the tie by preferring the context's own scope
-- system.
--
-- NOT CONCURRENTLY: the migration runner wraps each file in a transaction and
-- CREATE INDEX CONCURRENTLY cannot run inside one. This mirrors migration 075,
-- which built the comparable index on 176k rows in ~0.3 s.

CREATE INDEX IF NOT EXISTS "ix_Principals_externalId"
    ON "Principals" ("externalId")
 WHERE "externalId" IS NOT NULL;
