-- Add DEFAULT gen_random_uuid() to UUID primary key columns.
--
-- The v5 core schema created these columns without a DEFAULT, which means
-- the ingest engine cannot auto-generate IDs when callers (CSV crawlers,
-- custom connectors, test harness) send records without an explicit id.
-- SERIAL columns (e.g. Systems.id) already auto-generate via nextval();
-- UUID columns need the equivalent.

ALTER TABLE "Resources"               ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "Principals"              ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "Contexts"                ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "Identities"              ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "GovernanceCatalogs"      ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "AssignmentPolicies"      ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "AssignmentRequests"      ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "CertificationDecisions"  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "RiskClassifiers"         ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
