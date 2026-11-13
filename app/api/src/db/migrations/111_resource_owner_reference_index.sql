-- Identity Atlas — find the resources a person owns by the source's own reference
--
-- A source that names an owner on its resources keeps that reference in
-- "extendedAttributes" as `ownerId` (the SQL connector's contract column). A
-- resource's own page resolves it to a person; the person's page asks the
-- reverse — "which resources name me?" — and without an index that is a scan of
-- every resource on every page load. Catalogues of several hundred thousand
-- entitlements are normal.
--
-- Partial: only resources that carry the attribute are indexed, so a tenant
-- whose sources never write it pays nothing.

CREATE INDEX IF NOT EXISTS "ix_Resources_ownerIdReference"
    ON "Resources" (("extendedAttributes"->>'ownerId'))
 WHERE ("extendedAttributes"->>'ownerId') IS NOT NULL;
