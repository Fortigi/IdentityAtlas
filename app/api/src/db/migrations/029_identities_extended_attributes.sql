-- Add extendedAttributes JSONB column to Identities so Omada-specific fields
-- (identityStatus, riskScore, ouRefName, validFrom/To, etc.) can be persisted.
-- Nullable for backward compatibility with existing rows.
ALTER TABLE "Identities" ADD COLUMN IF NOT EXISTS "extendedAttributes" jsonb;
