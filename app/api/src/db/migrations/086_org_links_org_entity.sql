-- Migration 086: an organisation entity can be linked to an entity of another list.
--
-- A timesheet row names a customer; the customer list holds that customer. The
-- link between the two is an OrgLinks row like any other, with targetType
-- 'OrgEntity' and targetId the OrgEntities id. It is what lets the timesheet
-- say whether a customer's team really worked for it, and when it last did.
--
-- The CHECK on "targetType" (084) is replaced by one that adds 'OrgEntity'.
-- Its generated name is looked up rather than assumed.

DO $$
DECLARE c TEXT;
BEGIN
    FOR c IN
        SELECT con.conname FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
         WHERE rel.relname = 'OrgLinks' AND con.contype = 'c'
           AND pg_get_constraintdef(con.oid) LIKE '%targetType%'
    LOOP
        EXECUTE format('ALTER TABLE "OrgLinks" DROP CONSTRAINT %I', c);
    END LOOP;
END $$;

ALTER TABLE "OrgLinks" ADD CONSTRAINT "ck_OrgLinks_targetType"
    CHECK ("targetType" IN ('Identity','Principal','Resource','Context','OrgEntity'));
