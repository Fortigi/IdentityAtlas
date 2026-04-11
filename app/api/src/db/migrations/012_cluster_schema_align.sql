-- Align GraphResourceClusters with the clusters.js route expectations.
--
-- Migration 004 created a minimal schema; the route code was written for a
-- richer schema that was never migrated. This migration renames columns
-- and adds the missing ones so the /risk-scores/clusters endpoints work.

-- Rename columns to match route expectations
ALTER TABLE "GraphResourceClusters" RENAME COLUMN "name" TO "displayName";
ALTER TABLE "GraphResourceClusters" RENAME COLUMN "avgRiskScore" TO "aggregateRiskScore";
ALTER TABLE "GraphResourceClusters" RENAME COLUMN "maxRiskScore" TO "maxMemberRiskScore";
ALTER TABLE "GraphResourceClusters" RENAME COLUMN "ownerIdentityId" TO "ownerUserId";

-- Add missing columns
ALTER TABLE "GraphResourceClusters" ADD COLUMN IF NOT EXISTS "sourceClassifierId" TEXT;
ALTER TABLE "GraphResourceClusters" ADD COLUMN IF NOT EXISTS "sourceClassifierCategory" TEXT;
ALTER TABLE "GraphResourceClusters" ADD COLUMN IF NOT EXISTS "matchPatterns" TEXT;
ALTER TABLE "GraphResourceClusters" ADD COLUMN IF NOT EXISTS "memberCountProd" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GraphResourceClusters" ADD COLUMN IF NOT EXISTS "memberCountNonProd" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GraphResourceClusters" ADD COLUMN IF NOT EXISTS "avgMemberRiskScore" INTEGER;
ALTER TABLE "GraphResourceClusters" ADD COLUMN IF NOT EXISTS "riskTier" TEXT;
ALTER TABLE "GraphResourceClusters" ADD COLUMN IF NOT EXISTS "tierDistribution" TEXT;
ALTER TABLE "GraphResourceClusters" ADD COLUMN IF NOT EXISTS "ownerDisplayName" TEXT;
ALTER TABLE "GraphResourceClusters" ADD COLUMN IF NOT EXISTS "scoredAt" TIMESTAMPTZ;

-- Recreate indexes that referenced the old column name
DROP INDEX IF EXISTS "ix_Clusters_owner";
CREATE INDEX "ix_Clusters_owner" ON "GraphResourceClusters"("ownerUserId");
CREATE INDEX IF NOT EXISTS "ix_Clusters_riskTier" ON "GraphResourceClusters"("riskTier");
