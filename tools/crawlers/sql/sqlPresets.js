// Example query sets the wizard can load into the Queries step.
//
// A preset is a plain list of query slots in the crawler.json `queries[]`
// shape. The SQL follows the column contract in tools/crawlers/sql/CLAUDE.md:
// contract columns are aliased to their contract names, everything else
// lands in extendedAttributes under its own name.
//
// DELIBERATELY CONSERVATIVE. An IdentityIQ schema is half product, half
// customer: identity attributes in particular are configured per deployment,
// so a column that exists in one instance is an "Invalid column name" error in
// the next. Every column below was taken from a query that ran against a real
// IdentityIQ database. Columns that only *usually* exist (firstname, lastname,
// jobtitle, and the identity extended attributes) are named in comments for you
// to add, not selected — a preset that fails to run teaches nothing, and the
// failure arrives as a SQL error after the crawler has already connected.
//
// A preset is a starting point. To run a query you already have, paste it and
// set the slot's columnMap instead of rewriting it with aliases.

// SailPoint IdentityIQ (spt_* tables).
export const IDENTITYIQ_PRESET = [
  {
    name: 'Identities',
    target: 'identities',
    principalType: 'User',
    sql: `SELECT
    i.id,
    i.display_name,
    i.name     AS userId,
    i.email,
    i.manager  AS managerId,
    i.inactive,
    i.created,
    i.modified
    -- Add what your instance actually carries, e.g.
    --   , i.firstname AS givenName, i.lastname AS surname
    --   , i.jobtitle AS jobTitle, i.companyname AS companyName
    -- Anything not in the column contract is kept in extendedAttributes.
FROM spt_identity i
-- Workgroups are not people. Uncomment if your instance has the column:
-- WHERE i.is_workgroup = 0`,
  },
  {
    name: 'Entitlements',
    target: 'resources',
    resourceType: 'Entitlement',
    sql: `SELECT
    ma.id,
    COALESCE(NULLIF(ma.displayable_name, ''), ma.value) AS displayName,
    ma.value             AS entitlementValue,
    ma.attribute         AS attributeName,
    ma.type              AS entitlementType,
    ma.application       AS applicationId,
    app.name             AS applicationName,
    ma.owner             AS ownerId,
    owner.display_name   AS ownerName,
    ma.requestable,
    ma.aggregated,
    ma.uncorrelated,
    ma.created,
    ma.modified
FROM spt_managed_attribute ma
LEFT JOIN spt_application app ON app.id = ma.application
LEFT JOIN spt_identity owner  ON owner.id = ma.owner
WHERE ma.type = 'Entitlement'`,
  },
  {
    name: 'Business roles',
    target: 'resources',
    resourceType: 'BusinessRole',
    sql: `SELECT
    b.id,
    COALESCE(NULLIF(b.display_name, ''), b.name) AS displayName,
    b.name          AS roleName,
    b.type          AS roleType,
    b.disabled,
    b.owner         AS ownerId,
    i.display_name  AS ownerName,
    b.created,
    b.modified
FROM spt_bundle b
LEFT JOIN spt_identity i ON i.id = b.owner`,
  },
  {
    name: 'Entitlement assignments',
    target: 'assignments',
    resourceType: 'Entitlement',
    assignmentType: 'Direct',
    governed: false,
    sql: `-- Usually the largest table by far (tens of millions of rows). Rows stream
-- straight through, so no paging is needed; add
--   ORDER BY ie.identity_id, ma.id OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY
-- only if your server cuts long-running statements off.
SELECT
    ie.identity_id AS principalId,
    ma.id          AS resourceId
FROM spt_identity_entitlement ie
INNER JOIN spt_managed_attribute ma
    ON  ma.application = ie.application
    AND ma.attribute   = ie.name
    AND ma.value       = ie.value
WHERE ie.type = 'Entitlement'`,
  },
  {
    name: 'Role assignments',
    target: 'assignments',
    resourceType: 'BusinessRole',
    assignmentType: 'Direct',
    governed: true,
    sql: `SELECT
    identity_id AS principalId,
    bundle      AS resourceId,
    idx
FROM spt_identity_assigned_roles`,
  },
  {
    name: 'Role composition',
    target: 'relationships',
    relationshipType: 'Contains',
    sql: `-- CAVEAT: source_profile_id is a PROFILE id, not a managed-attribute id, so
-- these edges point at rows the Entitlements query above does not produce. The
-- crawler holds back a relationship whose ends it has not seen and reports them
-- as "dangling" — expect that count to equal this query's row count until you
-- resolve profiles to entitlements (join spt_profile and its constraints, or
-- ingest profiles as their own resourceType).
SELECT
    bpr.bundle_id         AS parentId,
    bpr.source_profile_id AS childId,
    bpr.attribute         AS entitlementAttribute,
    bpr.value             AS entitlementValue,
    bpr.display_value     AS entitlementName
FROM spt_bundle_profile_relation bpr`,
  },
];

export const PRESETS = [
  { id: 'identityiq', label: 'SailPoint IdentityIQ', description: 'Identities, entitlements, business roles, their assignments and role composition from the spt_* tables', queries: IDENTITYIQ_PRESET },
];

// Deep-copies a preset's slots so a wizard can edit them without touching the
// constant. Returns [] for an unknown id.
export function presetQueries(id) {
  const preset = PRESETS.find(p => p.id === id);
  return preset ? preset.queries.map(q => ({ enabled: true, ...q })) : [];
}
