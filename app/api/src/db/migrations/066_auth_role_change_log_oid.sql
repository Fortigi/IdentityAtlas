-- Identity Atlas — record the acting admin's immutable object id on role-mapping
-- changes (SEC-2026-09 L-01).
--
-- Migration 060 added "AuthRoleChangeLog" with a single "changedBy" column that
-- holds the first available display claim (name / UPN / oid). A display name is
-- mutable and not unique, so on its own it cannot reliably attribute a change to
-- one account. "changedByOid" stores the token's `oid` claim alongside it.
-- Nullable: rows written before this migration, and changes made while auth is
-- disabled, have no oid.

ALTER TABLE "AuthRoleChangeLog" ADD COLUMN IF NOT EXISTS "changedByOid" TEXT;
