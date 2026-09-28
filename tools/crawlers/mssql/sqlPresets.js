// Example query sets the wizard can load into the Queries step.
//
// A preset is a plain list of query slots in the crawler.json `queries[]`
// shape. The SQL follows the column contract in tools/crawlers/mssql/CLAUDE.md:
// contract columns are aliased to their contract names, everything else
// lands in extendedAttributes under its own name.
//
// An IdentityIQ schema is half product, half customer: identity attributes in
// particular are configured per deployment, so a column that exists in one
// instance is an "Invalid column name" error in the next. So there are two:
//
//   identityiq      only columns every IdentityIQ database has. Runs anywhere.
//   identityiq-org  adds the organisation extension columns and the
//                   logical-application catalogue a deployment typically adds;
//                   rename them to yours. Its defaults match the IdentityIQ-
//                   shaped fixture in tools/iiq-fixture/, which is where every
//                   statement here was proven.
//
// A preset is a starting point. To run a query you already have, paste it and
// set the slot's columnMap instead of rewriting it with aliases.

// ─── Shared statements ───────────────────────────────────────────────────────

const ENTITLEMENT_COLUMNS = `    ma.id,
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
    ma.modified`;

const ENTITLEMENT_FROM = `FROM spt_managed_attribute ma
LEFT JOIN spt_application app ON app.id = ma.application
LEFT JOIN spt_identity owner  ON owner.id = ma.owner`;

// NO filter on ma.type. It is the schema object type an entitlement came from
// (mostly 'group' in a real instance), not "is this an entitlement": every row
// in spt_managed_attribute is one. Filtering on type = 'Entitlement' loaded 454 of
// 805,497 in production, and every grant for the rest was held back as dangling.
// The type is kept as the entitlementType column instead.

// A grant that came from a role is Indirect: that is what Indirect means in the
// data model, and the matrix reads declared rows only, so access arriving through
// a role never shows unless it is stored that way. Two statements, two reconcile
// scopes, so one can never remove the other's rows. The same person can hold the
// same entitlement both ways, and both rows are kept.
function entitlementGrants(byRole) {
  return {
    name: byRole ? 'Entitlement grants via a role' : 'Entitlement grants',
    target: 'assignments',
    resourceType: 'Entitlement',
    assignmentType: byRole ? 'Indirect' : 'Direct',
    governed: false,
    sql: `-- Usually the largest table by far (tens of millions of rows). Rows stream
-- straight through, so no paging is needed. The join is on application +
-- attribute + value, which is unique per entitlement; joining on value alone
-- fans out wherever two attributes share a value.
SELECT
    ie.identity_id AS principalId,
    ma.id          AS resourceId
FROM spt_identity_entitlement ie
INNER JOIN spt_managed_attribute ma
    ON  ma.application = ie.application
    AND ma.attribute   = ie.name
    AND ma.value       = ie.value
WHERE ie.type = 'Entitlement'
  AND ${byRole ? 'ie.granted_by_role = 1' : '(ie.granted_by_role = 0 OR ie.granted_by_role IS NULL)'}`,
  };
}

const BUSINESS_ROLES = {
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
};

const ROLE_ASSIGNMENTS = {
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
};

const ROLE_COMPOSITION = {
  name: 'Role composition',
  target: 'relationships',
  relationshipType: 'Contains',
  sql: `-- Each row names the entitlement a role grants by application + attribute +
-- value, the same three columns a grant joins on. (source_profile_id is a PROFILE
-- id, not an entitlement id, and display_value is a name, so neither resolves.)
-- LEFT JOIN on purpose: a relation that matches no entitlement arrives without a
-- childId, is skipped, and is counted, instead of silently vanishing in a join.
SELECT
    bpr.bundle_id         AS parentId,
    ma.id                 AS childId,
    bpr.attribute         AS entitlementAttribute,
    bpr.value             AS entitlementValue,
    bpr.display_value     AS entitlementName
FROM spt_bundle_profile_relation bpr
LEFT JOIN spt_managed_attribute ma
    ON  ma.application = bpr.source_application
    AND ma.attribute   = bpr.attribute
    AND ma.value       = bpr.value`,
};

// ─── SailPoint IdentityIQ, stock columns only ────────────────────────────────

// One row per identity, loaded as a principal: IdentityIQ keeps the person and
// the account in the same row, and assignments hang off principals.
export const IDENTITYIQ_PRESET = [
  {
    name: 'Identities',
    target: 'principals',
    principalType: 'User',
    sql: `SELECT
    i.id,
    i.display_name,
    i.name     AS employeeId,
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
-- WHERE i.workgroup = 0`,
  },
  {
    name: 'Entitlements',
    target: 'resources',
    resourceType: 'Entitlement',
    sql: `SELECT
${ENTITLEMENT_COLUMNS}
${ENTITLEMENT_FROM}`,
  },
  BUSINESS_ROLES,
  entitlementGrants(false),
  entitlementGrants(true),
  ROLE_ASSIGNMENTS,
  ROLE_COMPOSITION,
];

// ─── SailPoint IdentityIQ with organisation extensions and applications ───────

// The two deployment-specific names the logical application hangs on. Change
// them (in the SQL below, once loaded) to your own.
export const CATALOG_RECORD = 'Application_Catalog';
export const APPLICATION_KEY = 'LogicalApplication';
const APPLICATION_XPATH = `(/Attributes/Map/entry[@key="${APPLICATION_KEY}"]/@value)[1]`;

export const IDENTITYIQ_ORG_PRESET = [
  {
    name: 'Identities',
    target: 'principals',
    principalType: 'User',
    sql: `-- Extension columns are deployment-specific: rename or drop what yours lacks.
SELECT
    i.id,
    i.display_name,
    i.name        AS employeeId,
    i.userid      AS userId,
    i.email,
    i.firstname   AS givenName,
    i.lastname    AS surname,
    i.jobtitle    AS jobTitle,
    i.subdivtext  AS department,
    i.companyname AS companyName,
    i.manager     AS managerId,
    i.inactive,
    i.companycode, i.departmentnumber, i.costcentercode,
    i.employeegroup, i.employeesubgroup, i.employeestatus,
    i.workcountry, i.locationid,
    i.divcode, i.divtext, i.seccode, i.sectext, i.subdivcode,
    i.hiredate, i.termination_date,
    i.created,
    i.modified
FROM spt_identity i
WHERE i.workgroup = 0 OR i.workgroup IS NULL`,
  },
  {
    name: 'Entitlements',
    target: 'resources',
    resourceType: 'Entitlement',
    sql: `SELECT
${ENTITLEMENT_COLUMNS},
    CAST(ma.attributes AS xml).value('${APPLICATION_XPATH}', 'nvarchar(450)') AS logicalApplication,
    ma.requestdelegateonly, ma.certfrequency, ma.costcentercode,
    ma.gpi_compliance, ma.trainingcheck, ma.ncdetection,
    ma.usexportcontrol, ma.iiq_elevated_access
${ENTITLEMENT_FROM}`,
  },
  {
    name: 'Logical applications',
    target: 'contexts',
    contextType: 'LogicalApplication',
    targetType: 'Resource',
    // Every application hangs under one root, so a catalogue of 1,500 is a tree
    // rather than 1,500 top-level rows. The crawler creates it; see
    // SqlCrawler.Contexts.ps1 → Get-SqlContextRoot.
    rootDisplayName: 'Logical Applications',
    sql: `-- One catalogue record whose XML maps each application NAME to its details.
-- Applications are keyed by their normalised name. When every entry carries a
-- unique configuration-management reference, alias that column to id instead:
-- it survives a rename, which a name does not.
SELECT
    e.k.value('@key', 'nvarchar(450)') AS displayName,
    e.k.value('(value/Map/entry[@key="description"]/@value)[1]', 'nvarchar(max)') AS description,
    -- The owner as the catalogue spells it. Deployments store an employee
    -- number here while accounts are keyed on the identity id; the crawler
    -- translates one to the other against the accounts it has read, and leaves
    -- anything it cannot match exactly as it found it (and counts it).
    e.k.value('(value/Map/entry[@key="owner"]/@value)[1]', 'nvarchar(255)') AS ownerUserId,
    -- Both spellings, because XQuery is case-sensitive and deployments differ:
    -- matching only "applicationOwner" returns NULL, silently, wherever the key
    -- is written "applicationowner". Kept as an extended attribute -- the
    -- "owner" key above is the one that becomes the context's owner.
    e.k.value('(value/Map/entry[@key="applicationOwner" or @key="applicationowner"]/@value)[1]', 'nvarchar(255)') AS applicationOwner,
    e.k.value('(value/Map/entry[@key="abbreviation"]/@value)[1]', 'nvarchar(255)') AS abbreviation,
    e.k.value('(value/Map/entry[@key="cmdbReference"]/@value)[1]', 'nvarchar(255)') AS cmdbReference,
    e.k.value('(value/Map/entry[@key="connectionType"]/@value)[1]', 'nvarchar(255)') AS connectionType,
    e.k.value('(value/Map/entry[@key="onboardingArea"]/@value)[1]', 'nvarchar(255)') AS onboardingArea
FROM spt_custom c
CROSS APPLY (SELECT CAST(c.attributes AS xml) AS x) doc
CROSS APPLY doc.x.nodes('/Attributes/Map/entry') e(k)
WHERE c.name = '${CATALOG_RECORD}'`,
  },
  {
    name: 'Logical application members',
    target: 'context-members',
    memberType: 'Resource',
    sql: `-- Each entitlement names its application in its own XML. The crawler matches
-- that name to the catalogue, ignoring case and surrounding spaces, and reports
-- every spelling it had to fold and every name the catalogue lacks.
SELECT
    ma.id AS memberId,
    CAST(ma.attributes AS xml).value('${APPLICATION_XPATH}', 'nvarchar(450)') AS contextName
FROM spt_managed_attribute ma`,
  },
  BUSINESS_ROLES,
  entitlementGrants(false),
  entitlementGrants(true),
  ROLE_ASSIGNMENTS,
  ROLE_COMPOSITION,
];

export const PRESETS = [
  { id: 'identityiq', label: 'SailPoint IdentityIQ', description: 'Identities, entitlements, business roles, their assignments (direct and via a role) and role composition from the stock spt_* columns', queries: IDENTITYIQ_PRESET },
  { id: 'identityiq-org', label: 'SailPoint IdentityIQ with organisation extensions', description: 'As above, plus typical identity extension columns and the logical applications kept in XML, as Contexts. Rename the extension columns and the catalogue names to your deployment\'s', queries: IDENTITYIQ_ORG_PRESET },
];

// Deep-copies a preset's slots so a wizard can edit them without touching the
// constant. Returns [] for an unknown id.
export function presetQueries(id) {
  const preset = PRESETS.find(p => p.id === id);
  return preset ? preset.queries.map(q => ({ enabled: true, ...q })) : [];
}
