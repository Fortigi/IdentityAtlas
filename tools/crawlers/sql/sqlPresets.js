// Example query sets the wizard can load into the Queries step.
//
// A preset is a plain list of query slots in the crawler.json `queries[]`
// shape. The SQL follows the column contract in tools/crawlers/sql/CLAUDE.md:
// contract columns are aliased to their contract names, everything else
// lands in extendedAttributes under its own name.
//
// Presets are a starting point, not a schema guarantee: an IGA product's
// extended attributes live in customer-specific columns, so the comments in
// the SQL say where to add them.

// SailPoint IdentityIQ (spt_* tables). Business roles, entitlements
// (managed attributes), and the identity <-> entitlement / role tables.
export const IDENTITYIQ_PRESET = [
  {
    name: 'Identities',
    target: 'identities',
    principalType: 'User',
    sql: `SELECT
    i.id,
    i.display_name AS displayName,
    i.name         AS userId,
    i.firstname    AS givenName,
    i.lastname     AS surname,
    i.email,
    i.manager      AS managerId,
    i.inactive,
    i.created,
    i.modified
    -- Extended identity attributes are customer-specific columns on spt_identity.
    -- Add them here; they are stored under their own name, e.g.
    --   , i.jobtitle AS jobTitle, i.departmentnumber AS department, i.companyname AS companyName
FROM spt_identity i
WHERE i.is_workgroup = 0`,
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
    app.id               AS applicationId,
    app.name             AS applicationName,
    owner.id             AS ownerId,
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
    sql: `-- This is usually the largest table (tens of millions of rows). The rows stream
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
    sql: `SELECT
    bpr.bundle_id         AS parentId,
    bpr.source_profile_id AS childId,
    bpr.attribute         AS entitlementAttribute,
    bpr.value             AS entitlementValue,
    bpr.display_value     AS entitlementName
FROM spt_bundle_profile_relation bpr`,
  },
  {
    name: 'Role hierarchy',
    target: 'relationships',
    relationshipType: 'Contains',
    sql: `SELECT
    bc.bundle AS parentId,
    bc.child  AS childId,
    bc.idx
FROM spt_bundle_children bc`,
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
