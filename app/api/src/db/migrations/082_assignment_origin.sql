-- Migration 082: where an assignment came from.
--
-- A governance source records, per grant, how it came to exist: a rule handed
-- it out, somebody requested it and it was approved, or the source simply found
-- it on the target system. Until now that had nowhere to go but
-- "extendedAttributes", where it could not be filtered and meant something
-- different per connector.
--
--   "origin"        the universal reading, one of three values:
--                     Automatic   a rule or birthright policy assigned it
--                     Requested   it was requested (and approved)
--                     Discovered  the source found it; nobody asked, no rule gave it
--                   NULL means the source does not say, which is NOT the same
--                   as Discovered and is what every existing row stays.
--   "originDetail"  the source's own word for it (IdentityIQ: Rule, LCM,
--                   Aggregation, ...), kept so the grouping can be audited.
--
-- Both are plain attributes of a grant. They are deliberately NOT part of the
-- row's key or of any reconcile scope ("governed" is, and needed special
-- handling for it): an assignment whose origin changes is the same row, updated.
--
-- Cost on a large table: adding a nullable column with no default does not
-- rewrite the table, and the CHECK is added NOT VALID so it is not verified by
-- scanning rows that are all NULL anyway. It is still enforced for every row
-- written from here on. Migrations run before the port binds, so a scan of
-- tens of millions of assignments here would be a startup outage.

ALTER TABLE "ResourceAssignments" ADD COLUMN IF NOT EXISTS "origin"       TEXT;
ALTER TABLE "ResourceAssignments" ADD COLUMN IF NOT EXISTS "originDetail" TEXT;

ALTER TABLE "ResourceAssignments" DROP CONSTRAINT IF EXISTS "ck_ResourceAssignments_origin";
ALTER TABLE "ResourceAssignments" ADD CONSTRAINT "ck_ResourceAssignments_origin"
    CHECK ("origin" IN ('Automatic', 'Requested', 'Discovered')) NOT VALID;
