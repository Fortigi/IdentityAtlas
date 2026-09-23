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

import { aggregateRowWhere, lastSignInExpr } from '../lib/principalActivity.js';
import { measurementCte } from '../reports/activityWindow.js';

const notDeleted = (t) => `${t}."deletedAt" IS NULL`;

// Sign-in activity, read through the same helpers as the standard activity
// reports, so "last sign-in" and "stale" mean the same thing in a custom report as
// in Never Signed In / Stale Accounts. Activity is a snapshot per system: the
// measurement moment (when that system's sign-in data was last collected) is
// what "days since" counts back from — not today — so a missed sync does not
// make everyone stale. It is computed once per query, as a CTE.
const SIGNIN_MEASUREMENT = { name: 'signin_measurement', sql: measurementCte() };
const lastSignIn = (t) => `(SELECT MAX(${lastSignInExpr('pa')}) FROM "PrincipalActivity" pa
          WHERE pa."principalId" = ${t}."id" AND ${aggregateRowWhere('pa')})`;
const signInMeasuredAt = (t) =>
  `(SELECT sm."measuredAt" FROM ${SIGNIN_MEASUREMENT.name} sm WHERE sm."systemId" = ${t}."systemId")`;
// `extKey` on the returned template records WHICH extendedAttributes key a field
// reads. extFields.js uses it to skip keys the static catalog already covers, so
// `userType` does not also show up as a raw `ext.userType` field.
const tagged = (key, fn) => Object.assign(fn, { extKey: key });
const ext = (key) => tagged(key, (t) => `${t}."extendedAttributes"->>'${key}'`);
const extBool = (key) => tagged(key, (t) => `(${t}."extendedAttributes"->>'${key}')::boolean`);

const col = (name) => (t) => `${t}."${name}"`;
// Ids are UUID columns, but the catalog offers them as text (contains, starts with,
// is empty …). Without the cast, text operators are invalid SQL on a UUID — found by
// contract-tests/customReportsCatalog.contract.test.js.
const idText = (t) => `${t}."id"::text`;
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
  // Takes a LIST. Its reason for existing is a follow-up question: "of these
  // groups, which are in an access package" has to name the groups the previous
  // answer produced, and naming them one OR-condition at a time is a definition
  // no small model writes correctly and no reader can check.
  in: { label: 'is one of', needsValue: true },
};

export const OPERATORS_BY_TYPE = {
  text: ['eq', 'neq', 'in', 'contains', 'notContains', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty'],
  enum: ['eq', 'neq', 'in', 'isEmpty', 'isNotEmpty'],
  boolean: ['eq', 'isEmpty', 'isNotEmpty'],
  number: ['eq', 'neq', 'gt', 'lt', 'isEmpty', 'isNotEmpty'],
  date: ['withinLastDays', 'olderThanDays', 'isEmpty', 'isNotEmpty'],
};

const BASE = {
  account: {
    label: 'Account',
    table: 'Principals',
    detailKind: 'user',
    description:
      'An account in a connected system: a person\'s user account (member or guest), a service principal, ' +
      'a managed identity or an AI agent. Use this entity only when non-human accounts matter or the request says "accounts" in general.',
    defaultColumns: ['displayName', 'email', 'principalType', 'accountEnabled'],
    where: notDeleted,
    fields: {
      id: { label: 'ID', type: 'text', sql: idText, description: 'unique account id' },
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
        label: 'Group count', type: 'number', counts: 'memberOf',
        description: 'number of groups the account is a member of',
        sql: (t) => `(SELECT count(*) FROM "ResourceAssignments" ra JOIN "Resources" r ON r."id" = ra."resourceId"
          WHERE ra."principalId" = ${t}."id" AND ra."deletedAt" IS NULL AND r."deletedAt" IS NULL
          AND r."resourceType" = 'Group' AND ra."assignmentType" IN ${HELD})`,
      },
      lastSignIn: {
        label: 'Last sign-in', type: 'date', sql: lastSignIn,
        // Kept short on purpose: longer descriptions here that talked about "empty"
        // values measurably pulled the model toward isEmpty / isNotEmpty on unrelated
        // boolean fields. How to phrase sign-in questions lives in prompt rule 2c.
        description: 'most recent sign-in (interactive or not)',
      },
      daysSinceLastSignIn: {
        label: 'Days since last sign-in', type: 'number', cte: SIGNIN_MEASUREMENT,
        sql: (t) => `(EXTRACT(DAY FROM ${signInMeasuredAt(t)} - ${lastSignIn(t)}))::int`,
        description: 'days since the last sign-in, counted from when sign-in data was collected',
      },
      signInDataCollected: {
        label: 'Sign-in data collected', type: 'date', cte: SIGNIN_MEASUREMENT, sql: signInMeasuredAt,
        description: 'when sign-in activity was last collected for this account\'s system',
      },
    },
    relations: {
      manager: {
        label: 'Manager', target: 'user', cardinality: 'one',
        some: 'has a manager', none: 'has no manager',
        description: 'the account\'s manager (another account)',
        from: (outer, inner) => ({
          from: `"Principals" ${inner}`,
          where: `${inner}."id" = ${outer}."managerId" AND ${notDeleted(inner)}`,
        }),
      },
      directReports: {
        label: 'Direct reports', target: 'user', cardinality: 'many',
        compareNoun: 'direct reports',
        some: 'has a direct report', none: 'has no direct reports',
        description: 'accounts that have this account as their manager',
        from: (outer, inner) => ({
          from: `"Principals" ${inner}`,
          where: `${inner}."managerId" = ${outer}."id" AND ${notDeleted(inner)}`,
        }),
      },
      memberOf: {
        label: 'Member of groups', target: 'group', cardinality: 'many',
        compareNoun: 'group memberships',
        some: 'is a member of a group', none: 'is not a member of any group',
        description: 'groups the account is a member of (direct or nested). ONLY groups — for roles, applications or permissions use access',
        from: (outer, inner, u) => {
          const ra = u();
          return {
            from: `"ResourceAssignments" ${ra} JOIN "Resources" ${inner} ON ${inner}."id" = ${ra}."resourceId"`,
            where: `${ra}."principalId" = ${outer}."id" AND ${ra}."deletedAt" IS NULL AND ${notDeleted(inner)}
              AND ${inner}."resourceType" = 'Group' AND ${ra}."assignmentType" IN ${HELD}`,
          };
        },
      },
      businessRoles: {
        label: 'Business roles', target: 'resource', cardinality: 'many',
        compareNoun: 'business roles',
        some: 'is in a business role', none: 'is not in any business role',
        description: 'business roles / access packages assigned to this account. Use this for "which business roles does X have" and as the businessRoles.names column',
        from: (outer, inner, u) => {
          const ra = u();
          return {
            from: `"ResourceAssignments" ${ra} JOIN "Resources" ${inner} ON ${inner}."id" = ${ra}."resourceId"`,
            where: `${ra}."principalId" = ${outer}."id" AND ${ra}."deletedAt" IS NULL AND ${notDeleted(inner)}
              AND ${inner}."resourceType" = 'BusinessRole' AND ${ra}."assignmentType" IN ${HELD}`,
          };
        },
      },
      access: {
        label: 'Has access to', target: 'resource', cardinality: 'many',
        compareNoun: 'access',
        some: 'has access to a resource', none: 'has no access to any resource',
        description: 'any resource the account holds: directory roles, groups, app roles, permissions, business roles, Azure roles. Use this for "has the X role"; for business roles only, use businessRoles',
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
        compareNoun: 'ownerships',
        some: 'owns a resource', none: 'owns no resource',
        description: 'groups and applications this account is an OWNER of (not membership)',
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
      identity: {
        label: 'Person', target: 'identity', cardinality: 'one',
        some: 'is linked to a person', none: 'is not linked to any person',
        description: 'the person (identity) this account belongs to, after account linking',
        from: (outer, inner, u) => {
          const im = u();
          return {
            from: `"IdentityMembers" ${im} JOIN "Identities" ${inner} ON ${inner}."id" = ${im}."identityId"`,
            where: `${im}."principalId" = ${outer}."id"`,
          };
        },
      },
    },
  },

  identity: {
    label: 'Identity',
    table: 'Identities',
    detailKind: 'identity',
    description:
      'A real person, linked to one or more accounts in different systems. Group memberships, access and ownership ' +
      'belong to the ACCOUNTS — a question about what persons have or are member of uses the user entity instead.',
    defaultColumns: ['displayName', 'email', 'department', 'jobTitle', 'accountCount'],
    where: () => 'TRUE',
    fields: {
      id: { label: 'ID', type: 'text', sql: idText, description: 'unique identity id' },
      displayName: { label: 'Name', type: 'text', sql: col('displayName') },
      email: { label: 'Email', type: 'text', sql: col('email') },
      givenName: { label: 'First name', type: 'text', sql: col('givenName') },
      surname: { label: 'Last name', type: 'text', sql: col('surname') },
      employeeId: { label: 'Employee ID', type: 'text', sql: col('employeeId') },
      department: { label: 'Department', type: 'text', sql: col('department') },
      jobTitle: { label: 'Job title', type: 'text', sql: col('jobTitle') },
      companyName: { label: 'Company', type: 'text', sql: col('companyName') },
      city: { label: 'City', type: 'text', sql: col('city') },
      country: { label: 'Country', type: 'text', sql: col('country') },
      officeLocation: { label: 'Office', type: 'text', sql: col('officeLocation') },
      analystVerified: { label: 'Verified by analyst', type: 'boolean', sql: col('analystVerified') },
      linkConfidence: { label: 'Link confidence', type: 'number', sql: col('linkConfidence'), description: 'how sure the account linking is, 0–100' },
      accountCount: {
        label: 'Account count', type: 'number', counts: 'accounts', description: 'number of accounts linked to this person',
        sql: (t) => `(SELECT count(*) FROM "IdentityMembers" im JOIN "Principals" p ON p."id" = im."principalId"
          WHERE im."identityId" = ${t}."id" AND p."deletedAt" IS NULL)`,
      },
    },
    relations: {
      accounts: {
        label: 'Accounts', target: 'account', cardinality: 'many',
        compareNoun: 'accounts',
        some: 'has an account', none: 'has no accounts',
        description: 'the accounts (in any system) linked to this person',
        from: (outer, inner, u) => {
          const im = u();
          return {
            from: `"IdentityMembers" ${im} JOIN "Principals" ${inner} ON ${inner}."id" = ${im}."principalId"`,
            where: `${im}."identityId" = ${outer}."id" AND ${notDeleted(inner)}`,
          };
        },
      },
      manager: {
        label: 'Manager', target: 'identity', cardinality: 'one',
        some: 'has a manager', none: 'has no manager',
        description: 'the person this person reports to',
        from: (outer, inner) => ({
          from: `"Identities" ${inner}`,
          where: `${inner}."id" = ${outer}."managerIdentityId"`,
        }),
      },
    },
  },

  resource: {
    label: 'Resource',
    table: 'Resources',
    detailKind: 'resource',
    description:
      'Anything that grants access: a group, a directory role, an application, an app role, a permission, ' +
      'a business role (access package) or an Azure resource. For groups use the group entity.',
    defaultColumns: ['displayName', 'resourceType', 'description'],
    where: (t) => `${notDeleted(t)} AND ${t}."resourceType" NOT IN ${OWNERSHIP_TYPES}`,
    fields: {
      id: { label: 'ID', type: 'text', sql: idText, description: 'unique resource id' },
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
        label: 'Member count', type: 'number', counts: 'members',
        description: 'number of accounts that hold this resource (members / assignees)',
        sql: (t) => `(SELECT count(*) FROM "ResourceAssignments" ra
          WHERE ra."resourceId" = ${t}."id" AND ra."deletedAt" IS NULL AND ra."assignmentType" IN ${HELD})`,
      },
      ownerCount: {
        label: 'Owner count', type: 'number', counts: 'owners', description: 'number of owners',
        sql: (t) => `(SELECT count(*) FROM "ResourceRelationships" rr JOIN "ResourceAssignments" ra ON ra."resourceId" = rr."childResourceId"
          WHERE rr."parentResourceId" = ${t}."id" AND rr."relationshipType" IN ('HasOwnership','HasAppOwnership') AND ra."deletedAt" IS NULL)`,
      },
    },
    relations: {
      members: {
        label: 'Members', target: 'account', cardinality: 'many',
        compareNoun: 'members',
        some: 'has a member', none: 'has no members',
        description: 'accounts that are members of / assigned to this resource (NOT owners)',
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
        compareNoun: 'owners',
        some: 'has an owner', none: 'has no owner',
        description: 'accounts that OWN this group or application (NOT members). "nobody owns" = owners none',
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
        compareNoun: 'business roles',
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

// ── What changed, and when ───────────────────────────────────────────────
//
// Every other entity here answers "what is true now". This one answers "what
// became true, and when" — the question a manager actually asks, and the one
// the catalog could not express at all: "zijn er recent leden aan deze groepen
// toegevoegd of verwijderd?"
//
// It reads the `AssignmentChanges` view (migration 070), which projects the
// audit trail into rows with a date and an action. The awkward part lives in
// the view rather than here: a REMOVED membership is recorded as an UPDATE that
// stamps `deletedAt`, not as a delete, because ResourceAssignments is a
// soft-delete table. Anything reading `_history` directly and looking for
// deletions finds only the hard ones, which stopped the day soft delete
// shipped.
//
// `managerId` is a column rather than a second hop for a reason a report
// author would not guess: a condition may nest a relation ONE level deep
// (spec.js), so "changes to the access of the people who report to me" cannot
// be walked as change → account → manager. It has to be reachable in one step.
const CHANGE = {
  label: 'Change',
  table: 'AssignmentChanges',
  // No detail page exists for a change — it is an event, not a record. Null
  // keeps the bot from offering a link to one, and from carrying changes
  // forward as the subject of a follow-up question.
  detailKind: null,
  // Alphabetical order on a list of events is useless; the newest change is
  // the point. Nothing else in the catalog needs a default, so this is the
  // only entity that sets one.
  defaultSort: { field: 'changedAt', direction: 'desc' },
  description:
    'A membership or access grant that was ADDED or REMOVED, and when. Use this entity — and ONLY this entity — '
    + 'for questions about what CHANGED, what is NEW, what was REMOVED, or what happened "recently" / "lately" / '
    + '"in the last N days". Every other entity describes what is true now and cannot answer those. '
    + 'Covers group membership, access packages, app roles and directory roles alike.',
  defaultColumns: ['changedAt', 'action', 'account.displayName', 'resource.displayName'],
  // Which relation a follow-up question means by "these groups" / "these
  // accounts". Declared rather than inferred: both `account` and `manager`
  // point at accounts, so a rule that picked the first relation with a
  // matching target would depend on the order they happen to be written in.
  narrowVia: { resource: 'resource', user: 'account' },
  where: () => 'TRUE',
  fields: {
    id: { label: 'ID', type: 'text', sql: idText, description: 'unique change id' },
    displayName: {
      label: 'Change', type: 'text', sql: col('displayName'),
      description: 'who and what, as one line ("Jan de Vries — Finance")',
    },
    changedAt: {
      label: 'Changed', type: 'date', sql: col('changedAt'),
      description: 'when the change happened. "recently" / "recent" / "de laatste tijd" is this field, within the last 30 days unless the request says otherwise',
    },
    action: {
      label: 'Action', type: 'enum', sql: col('action'), valuesFrom: 'changeAction',
      description: '"Added" (granted, or granted back) or "Removed" (revoked)',
    },
    assignmentType: {
      label: 'Assignment type', type: 'enum', sql: col('assignmentType'), valuesFrom: 'assignmentType',
      description: 'Direct, Indirect (through a group) or Eligible (can activate it)',
    },
  },
  relations: {
    account: {
      label: 'Account', target: 'account', cardinality: 'one',
      some: 'has an account', none: 'has no account',
      description: 'the account this change was about — who gained or lost the access',
      from: (outer, inner) => ({
        from: `"Principals" ${inner}`,
        where: `${inner}."id" = ${outer}."principalId"`,
      }),
    },
    resource: {
      label: 'Resource', target: 'resource', cardinality: 'one',
      some: 'is about a resource', none: 'is about no resource',
      description: 'the group, application or role the access was on',
      from: (outer, inner) => ({
        from: `"Resources" ${inner}`,
        where: `${inner}."id" = ${outer}."resourceId"`,
      }),
    },
    manager: {
      label: 'Manager', target: 'account', cardinality: 'one',
      some: 'the account has a manager', none: 'the account has no manager',
      description: 'the manager of the account this change was about. "changes for my people / my team / mijn medewerkers" is this relation',
      from: (outer, inner) => ({
        from: `"Principals" ${inner}`,
        where: `${inner}."id" = ${outer}."managerId"`,
      }),
    },
  },
};

// Analysts think in "users" and "groups", and small models reliably forget the
// "principalType = User" / "resourceType = Group" filter when those are only a
// field. So they are entities of their own: the base entity with the type
// filter built in and the type field removed. A spec that still states the
// implied type (e.g. group + resourceType = Group) is accepted — see spec.js.
function derive(base, { label, description, typeField, typeValue, defaultColumns }) {
  const fields = { ...base.fields };
  delete fields[typeField];
  return {
    ...base, label, description, defaultColumns, fields,
    implicit: { field: typeField, value: typeValue },
    where: (t) => `${base.where(t)} AND ${t}."${typeField}" = '${typeValue}'`,
  };
}

export const ENTITIES = {
  user: derive(BASE.account, {
    label: 'User', typeField: 'principalType', typeValue: 'User',
    description: 'A user account of a person (members and guests). Use for "users", "accounts", "guests" — and for what people are member of or have access to.',
    defaultColumns: ['displayName', 'email', 'userType', 'accountEnabled'],
  }),
  group: derive(BASE.resource, {
    label: 'Group', typeField: 'resourceType', typeValue: 'Group',
    description: 'A security or Microsoft 365 group. Use for "groups".',
    defaultColumns: ['displayName', 'description', 'memberCount'],
  }),
  identity: BASE.identity,
  account: BASE.account,
  resource: BASE.resource,
  change: CHANGE,
};

// ─── Fields, including the discovered extendedAttributes ones ────────
//
// The static catalog above is the vocabulary every deployment shares. On top of
// it, each install has its own `extendedAttributes` keys — `sfDepartmentID`,
// `fgGroupDN_OuPath`, whatever the crawlers stamp — and an analyst must be able
// to filter, show and group on those too. They are discovered per request (see
// extFields.js) and merged in HERE rather than mutated into ENTITIES, so nothing
// deployment-specific ever reaches the byte-stable system prompt or leaks between
// tests.

/** The entity's own fields, plus the discovered `ext.*` fields handed in. */
export function fieldsOf(entityName, extFields) {
  const base = ENTITIES[entityName].fields;
  const extra = extFields?.[entityName];
  return extra ? { ...base, ...extra } : base;
}

/** The `extendedAttributes` keys the static fields of an entity already read. */
export function staticExtKeys(entityName) {
  return new Set(Object.values(ENTITIES[entityName].fields).map(f => f.sql.extKey).filter(Boolean));
}

// Words analysts use interchangeably. Rendered into the prompt, so the model maps

// every synonym to the same entity or filter. Dutch terms included: questions
// arrive in both languages.
export const GLOSSARY = [
  { terms: ['person', 'people', 'identity', 'human', 'persoon', 'personen', 'medewerker'], means: 'the identity entity (a real person). For what a person is member of, has access to or owns, use the user entity.' },
  { terms: ['account', 'user', 'user account', 'principal', 'login', 'gebruiker', 'gebruikersaccount'], means: 'the user entity; the account entity when non-human accounts (service principals, managed identities, AI agents) are included' },
  { terms: ['business role', 'access package', 'role package', 'bedrijfsrol', 'toegangspakket'], means: 'a resource with resourceType BusinessRole; the business roles an account or a group is in are the businessRoles relation — as a condition ("in business role X") and as the businessRoles.names column' },
  { terms: ['group', 'security group', 'Microsoft 365 group', 'team', 'groep'], means: 'the group entity' },
  { terms: ['directory role', 'admin role', 'Entra role', 'administrator role', 'beheerrol'], means: 'a resource with resourceType EntraDirectoryRole' },
  { terms: ['application', 'enterprise application', 'app', 'applicatie'], means: 'a resource with resourceType Application' },
  { terms: ['service principal', 'app identity', 'service account'], means: 'an account with principalType ServicePrincipal' },
  { terms: ['guest', 'external user', 'B2B user', 'gast', 'externe gebruiker'], means: 'userType Guest' },
  { terms: ['disabled', 'inactive', 'blocked', 'uitgeschakeld'], means: 'accountEnabled false' },
  { terms: ['owner', 'eigenaar'], means: 'the owners / owns relation — never membership' },
  { terms: ['change', 'changed', 'changes', 'added', 'removed', 'new', 'recent', 'recently', 'lately', 'wijziging', 'wijzigingen', 'veranderd', 'toegevoegd', 'verwijderd', 'nieuw'], means: 'the change entity — what was added or removed over time. Every other entity only describes the present.' },
  { terms: ['my people', 'my team', 'my staff', 'my employees', 'mijn medewerkers', 'mijn team', 'mijn mensen'], means: 'the accounts whose manager is the person asking' },
];

// Distinct-value lookups for enum fields — metadata only (a handful of type
// names), used to ground the prompt and to normalise model output.
export const VALUE_QUERIES = {
  // Not read from the view: the two values are defined by the view's own CASE,
  // so asking the data would return whichever of them happen to have occurred
  // — and a deployment with no removals yet would leave "Removed" unknown, so
  // a question about removals would be rejected as an unknown value.
  changeAction: `SELECT unnest(ARRAY['Added', 'Removed']) v`,
  assignmentType: `SELECT unnest(ARRAY['Direct', 'Indirect', 'Eligible']) v`,
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
