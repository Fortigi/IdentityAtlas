-- Migration 087: one link per entity, target AND attribute.
--
-- A customer's owner can also be in its team: the same account is then linked
-- to the same entity twice, once through "eigenaar" and once through "team".
-- 084's UNIQUE ("orgEntityId", "targetType", "targetId") allowed only one of
-- the two, and an import writing both failed ("ON CONFLICT DO UPDATE command
-- cannot affect row a second time"). The uniqueness now includes "via" (085);
-- a link written before 085 has none and counts as via ''.

DO $$
DECLARE c TEXT;
BEGIN
    FOR c IN
        SELECT con.conname FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
         WHERE rel.relname = 'OrgLinks' AND con.contype = 'u'
    LOOP
        EXECUTE format('ALTER TABLE "OrgLinks" DROP CONSTRAINT %I', c);
    END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ux_OrgLinks_entity_target_via"
    ON "OrgLinks" ("orgEntityId", "targetType", "targetId", (COALESCE("via", '')));
