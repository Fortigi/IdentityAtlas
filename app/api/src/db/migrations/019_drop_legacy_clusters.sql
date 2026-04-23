-- Phase 7 of the context redesign: retire the standalone
-- GraphResourceClusters feature. Clustering now runs as a registered
-- context-algorithm plugin (`resource-cluster`) and writes to
-- Contexts + ContextMembers alongside every other variant='generated' tree.
--
-- The Phase 1 handover claimed these tables were already dropped — they
-- weren't, migrations 004 and 012 still created/evolved them. This migration
-- actually removes them.

DROP TABLE IF EXISTS "GraphResourceClusterMembers" CASCADE;
DROP TABLE IF EXISTS "GraphResourceClusters"       CASCADE;
