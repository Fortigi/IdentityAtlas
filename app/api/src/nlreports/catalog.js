// Natural-language reports (PROTOTYPE) — the semantic catalog.
//
// This is the whole vocabulary the LLM is allowed to use. It never sees table or
// column names: it sees entities, fields and relations described in analyst
// language, and fills in a report spec (see spec.js). compile.js turns a
// validated spec into parameterised SQL using the templates below.
//
// SQL templates are functions of a table alias, so the same field can be used on
// the root entity and inside a relation subquery without alias collisions. Every
// template is a constant — no user or model input is ever interpolated into SQL.

const notDeleted = (t) => `${t}."deletedAt" IS NULL`;
const ext = (key) => (t) => `${t}."extendedAttributes"->>'${key}'`;
const extBool = (key) => (t) => `(${t}."extendedAttributes"->>'${key}')::boolean`;
const col = (name) => (t) => `${t}."${name}"`;
const systemName = (t) => `(SELECT s."displayName" FROM "Systems" s WHERE s."id" = ${t}."systemId")`;

// Assignment types that mean "is a member / has it" (Eligible = could activate it).
const HELD = `('Direct','Indirect')`;
const OWNERSHIP_TYPES = `('GroupOwnership','ApplicationOwnership','ServicePrincipalOwnership')`;

export const OPERATORS = {
  eq: { label: 'is', needsValue: true },
  neq: { label: 'is not', needsValue: true },
  contains: { label: 'contains', needsValue: true },
  notContains: { label: 'does not contain', needsValue: true },
  startsWith: { label: 'starts with', needsValue: true },
  endsWith: { label: 'ends with', needsValue: true },
  isEmpty: { label: 'is empty', needsValue: false },
  isNotEmpty: { label: 'is not empty', needsValue: false },
  gt: { label: 'is more than', needsValue: true },
  lt: { label: 'is less than', needsValue: true },
  withinLastDays: { label: 'is within the last N days', needsValue: true },
  olderThanDays: { label: 'is more than N days ago', needsValue: true },
};

export const OPERATORS_BY_TYPE = {
  text: ['eq', 'neq', 'contains', 'notContains', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty'],
  enum: ['eq', 'neq', 'isEmpty', 'isNotEmpty'],
  boolean: ['eq', 'isEmpty', 'isNotEmpty'],
  number: ['eq', 'neq', 'gt', 'lt', 'isEmpty', 'isNotEmpty'],
  date: ['withinLastDays', 'olderThanDays', 'isEmpty', 'isNotEmpty'],
};

export const ENTITIES = {
  account: {
    label: 'Account',
    table: 'Principals',
    detailKind: 'user',
    description:
      'An account in a connected system: a person\'s user account (member or guest), a service principal, ' +
      'a managed identity or an AI agent. "Users" normally means accounts with type User.',
    defaultColumns: ['displayName', 'email', 'principalType', 'accountEnabled'],
    where: notDeleted,
    fields: {
      id: { label: 'ID', type: 'text', sql: col('id'), description: 'unique account id' },
      displayName: { label: 'Name', type: 'text', sql: col('displayName'), description: 'display name' },
      email: { label: 'Email', type: 'text', sql: col('email'), description: 'email / UPN' },
      principalType: {
        label: 'Account type', type: 'enum', sql: col('principalType'),
        description: 'kind of account', valuesFrom: 'principalType',
      },
      userType: {
        label: 'User type', type: 'enum', sql: ext('userType'),
        description: 'Member or Guest (guest = external / B2B user)', valuesFrom: 'userType',
      },
      accountEnabled: {
        label: 'Enabled', type: 'boolean', sql: col('accountEnabled'),
        description: 'true = enabled / active, false = disabled / blocked',
      },
      givenName: { label: 'First name', type: 'text', sql: col('givenName') },
      surname: { label: 'Last name', type: 'text', sql: col('surname') },
      department: { label: 'Department', type: 'text', sql: col('department') },
      jobTitle: { label: 'Job title', type: 'text', sql: col('jobTitle') },
      companyName: { label: 'Company', type: 'text', sql: col('companyName') },
      employeeId: { label: 'Employee ID', type: 'text', sql: col('employeeId') },
      employeeType: { label: 'Employee type', type: 'text', sql: ext('employeeType') },
      usageLocation: { label: 'Usage location', type: 'text', sql: ext('usageLocation'), description: 'country code' },
      externalUserState: {
        label: 'Guest invitation state', type: 'enum', sql: ext('externalUserState'),
        description: 'PendingAcceptance or Accepted (guests only)', valuesFrom: 'externalUserState',
      },
      createdDateTime: { label: 'Created', type: 'date', sql: col('createdDateTime'), description: 'when the account was created' },
      system: { label: 'System', type: 'enum', sql: systemName, description: 'source system name', valuesFrom: 'systemName' },
      riskTier: { label: 'Risk tier', type: 'enum', sql: col('riskTier'), valuesFrom: 'principalRiskTier' },
      groupCount: {
        label: 'Group count', type: 'number',
        description: 'number of groups the account is a member of',
        sql: (t) => `(SELECT count(*) FROM "ResourceAssignments" ra JOIN "Resources" r ON r."id" = ra."resourceId"
          WHERE ra."principalId" = ${t}."id" AND ra."deletedAt" IS NULL AND r."deletedAt" IS NULL
          AND r."resourceType" = 'Group' AND ra."assignmentType" IN ${HELD})`,
      },
    },
    relations: {
      manager: {
        label: 'Manager', target: 'account', cardinality: 'one',
        some: 'has a manager', none: 'has no manager',
        description: 'the account\'s manager (another account)',
        from: (outer, inner) => ({
          from: `"Principals" ${inner}`,
          where: `${inner}."id" = ${outer}."managerId" AND ${notDeleted(inner)}`,
        }),
      },
      directReports: {
        label: 'Direct reports', target: 'account', cardinality: 'many',
        some: 'has a direct report', none: 'has no direct reports',
        description: 'accounts that have this account as their manager',
        from: (outer, inner) => ({
          from: `"Principals" ${inner}`,
          where: `${inner}."managerId" = ${outer}."id" AND ${notDeleted(inner)}`,
        }),
      },
      memberOf: {
        label: 'Member of groups', target: 'resource', cardinality: 'many',
        some: 'is a member of a group', none: 'is not a member of any group',
        description: 'groups the account is a member of (direct or indirect/nested)',
        from: (outer, inner, u) => {
          const ra = u();
          return {
            from: `"ResourceAssignments" ${ra} JOIN "Resources" ${inner} ON ${inner}."id" = ${ra}."resourceId"`,
            where: `${ra}."principalId" = ${outer}."id" AND ${ra}."deletedAt" IS NULL AND ${notDeleted(inner)}
              AND ${inner}."resourceType" = 'Group' AND ${ra}."assignmentType" IN ${HELD}`,
          };
        },
      },
      access: {
        label: 'Has access to', target: 'resource', cardinality: 'many',
        some: 'has access to a resource', none: 'has no access to any resource',
        description: 'any resource the account holds: groups, directory roles, app roles, permissions, business roles, Azure roles',
        from: (outer, inner, u) => {
          const ra = u();
          return {
            from: `"ResourceAssignments" ${ra} JOIN "Resources" ${inner} ON ${inner}."id" = ${ra}."resourceId"`,
            where: `${ra}."principalId" = ${outer}."id" AND ${ra}."deletedAt" IS NULL AND ${notDeleted(inner)}
              AND ${inner}."resourceType" NOT IN ${OWNERSHIP_TYPES}`,
          };
        },
      },
      owns: {
        label: 'Owner of', target: 'resource', cardinality: 'many',
        some: 'owns a resource', none: 'owns no resource',
        description: 'groups and applications this account is an owner of',
        from: (outer, inner, u) => {
          const ra = u(); const rr = u();
          return {
            from: `"ResourceAssignments" ${ra} JOIN "ResourceRelationships" ${rr} ON ${rr}."childResourceId" = ${ra}."resourceId"
              JOIN "Resources" ${inner} ON ${inner}."id" = ${rr}."parentResourceId"`,
            where: `${ra}."principalId" = ${outer}."id" AND ${ra}."deletedAt" IS NULL AND ${notDeleted(inner)}
              AND ${rr}."relationshipType" IN ('HasOwnership','HasAppOwnership')`,
          };
        },
      },
    },
  },

  resource: {
    label: 'Resource',
    table: 'Resources',
    detailKind: 'resource',
    description:
      'Anything that grants access: a group, a directory role, an application, an app role, a permission, ' +
      'a business role (access package) or an Azure resource. "Groups" means resources with type Group.',
    defaultColumns: ['displayName', 'resourceType', 'description'],
    where: (t) => `${notDeleted(t)} AND ${t}."resourceType" NOT IN ${OWNERSHIP_TYPES}`,
    fields: {
      id: { label: 'ID', type: 'text', sql: col('id'), description: 'unique resource id' },
      displayName: { label: 'Name', type: 'text', sql: col('displayName'), description: 'display name' },
      description: { label: 'Description', type: 'text', sql: col('description') },
      resourceType: {
        label: 'Resource type', type: 'enum', sql: col('resourceType'),
        description: 'kind of resource', valuesFrom: 'resourceType',
      },
      mail: { label: 'Mail address', type: 'text', sql: col('mail') },
      visibility: { label: 'Visibility', type: 'enum', sql: col('visibility'), valuesFrom: 'visibility' },
      securityEnabled: { label: 'Security enabled', type: 'boolean', sql: extBool('securityEnabled'), description: 'groups: is a security group' },
      mailEnabled: { label: 'Mail enabled', type: 'boolean', sql: extBool('mailEnabled'), description: 'groups: is mail enabled' },
      dynamicMembership: {
        label: 'Dynamic membership', type: 'boolean',
        sql: (t) => `(${t}."extendedAttributes"->>'membershipRule') IS NOT NULL`,
        description: 'groups: membership is rule-based (dynamic group)',
      },
      roleAssignable: { label: 'Role assignable', type: 'boolean', sql: extBool('isAssignableToRole'), description: 'groups: can be assigned to Entra roles' },
      createdDateTime: { label: 'Created', type: 'date', sql: col('createdDateTime') },
      system: { label: 'System', type: 'enum', sql: systemName, valuesFrom: 'systemName' },
      riskTier: { label: 'Risk tier', type: 'enum', sql: col('riskTier'), valuesFrom: 'resourceRiskTier' },
      memberCount: {
        label: 'Member count', type: 'number',
        description: 'number of accounts that hold this resource (members / assignees)',
        sql: (t) => `(SELECT count(*) FROM "ResourceAssignments" ra
          WHERE ra."resourceId" = ${t}."id" AND ra."deletedAt" IS NULL AND ra."assignmentType" IN ${HELD})`,
      },
      ownerCount: {
        label: 'Owner count', type: 'number', description: 'number of owners',
        sql: (t) => `(SELECT count(*) FROM "ResourceRelationships" rr JOIN "ResourceAssignments" ra ON ra."resourceId" = rr."childResourceId"
          WHERE rr."parentResourceId" = ${t}."id" AND rr."relationshipType" IN ('HasOwnership','HasAppOwnership') AND ra."deletedAt" IS NULL)`,
      },
    },
    relations: {
      members: {
        label: 'Members', target: 'account', cardinality: 'many',
        some: 'has a member', none: 'has no members',
        description: 'accounts that are members of / assigned to this resource (direct or indirect)',
        from: (outer, inner, u) => {
          const ra = u();
          return {
            from: `"ResourceAssignments" ${ra} JOIN "Principals" ${inner} ON ${inner}."id" = ${ra}."principalId"`,
            where: `${ra}."resourceId" = ${outer}."id" AND ${ra}."deletedAt" IS NULL AND ${notDeleted(inner)}
              AND ${ra}."assignmentType" IN ${HELD}`,
          };
        },
      },
      owners: {
        label: 'Owners', target: 'account', cardinality: 'many',
        some: 'has an owner', none: 'has no owner',
        description: 'accounts that own this group or application',
        from: (outer, inner, u) => {
          const ra = u(); const rr = u();
          return {
            from: `"ResourceRelationships" ${rr} JOIN "ResourceAssignments" ${ra} ON ${ra}."resourceId" = ${rr}."childResourceId"
              JOIN "Principals" ${inner} ON ${inner}."id" = ${ra}."principalId"`,
            where: `${rr}."parentResourceId" = ${outer}."id" AND ${rr}."relationshipType" IN ('HasOwnership','HasAppOwnership')
              AND ${ra}."deletedAt" IS NULL AND ${notDeleted(inner)}`,
          };
        },
      },
      businessRoles: {
        label: 'In business roles', target: 'resource', cardinality: 'many',
        some: 'is in a business role', none: 'is not in any business role',
        description: 'business roles / access packages that contain this resource',
        from: (outer, inner, u) => {
          const rr = u();
          return {
            from: `"ResourceRelationships" ${rr} JOIN "Resources" ${inner} ON ${inner}."id" = ${rr}."parentResourceId"`,
            where: `${rr}."childResourceId" = ${outer}."id" AND ${rr}."relationshipType" = 'Contains'
              AND ${inner}."resourceType" = 'BusinessRole' AND ${notDeleted(inner)}`,
          };
        },
      },
    },
  },
};

// Distinct-value lookups for enum fields — metadata only (a handful of type
// names), used to ground the prompt and to normalise model output.
export const VALUE_QUERIES = {
  principalType: `SELECT DISTINCT "principalType" v FROM "Principals" WHERE "deletedAt" IS NULL AND "principalType" IS NOT NULL`,
  userType: `SELECT DISTINCT "extendedAttributes"->>'userType' v FROM "Principals" WHERE "extendedAttributes"->>'userType' IS NOT NULL`,
  externalUserState: `SELECT DISTINCT "extendedAttributes"->>'externalUserState' v FROM "Principals" WHERE "extendedAttributes"->>'externalUserState' IS NOT NULL`,
  resourceType: `SELECT DISTINCT "resourceType" v FROM "Resources" WHERE "deletedAt" IS NULL AND "resourceType" IS NOT NULL
    AND "resourceType" NOT IN ${OWNERSHIP_TYPES}`,
  visibility: `SELECT DISTINCT "visibility" v FROM "Resources" WHERE "visibility" IS NOT NULL`,
  systemName: `SELECT DISTINCT "displayName" v FROM "Systems"`,
  principalRiskTier: `SELECT DISTINCT "riskTier" v FROM "Principals" WHERE "riskTier" IS NOT NULL`,
  resourceRiskTier: `SELECT DISTINCT "riskTier" v FROM "Resources" WHERE "riskTier" IS NOT NULL`,
};
