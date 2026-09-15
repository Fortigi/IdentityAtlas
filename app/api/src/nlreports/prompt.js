// Natural-language reports (PROTOTYPE) — prompt + constrained-output schema.
//
// The system prompt is built from the catalog plus the enum values that exist
// in the data (type names only — never rows). It is kept byte-stable between
// requests so a local model server can reuse its prompt cache: only the
// conversation after it has to be processed on each question.
//
// RESPONSE_SCHEMA is handed to the model server as a JSON schema, which the
// server compiles into a decoding grammar: the model physically cannot emit
// anything that is not a well-formed reply with known field/relation names.

import { ENTITIES, OPERATORS_BY_TYPE, OPERATORS } from './catalog.js';

const allFieldNames = [...new Set(Object.values(ENTITIES).flatMap(e => Object.keys(e.fields)))];
const allRelationNames = [...new Set(Object.values(ENTITIES).flatMap(e => Object.keys(e.relations)))];

const FIELD_CONDITION = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['field'] },
    field: { type: 'string', enum: allFieldNames },
    op: { type: 'string', enum: Object.keys(OPERATORS) },
    value: { type: ['string', 'number', 'boolean', 'null'] },
  },
  required: ['type', 'field', 'op', 'value'],
};

const RELATION_CONDITION = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['relation'] },
    relation: { type: 'string', enum: allRelationNames },
    quantifier: { type: 'string', enum: ['some', 'none'] },
    match: { type: 'string', enum: ['all', 'any'] },
    conditions: { type: 'array', items: FIELD_CONDITION },
  },
  required: ['type', 'relation', 'quantifier', 'match', 'conditions'],
};

const GROUP_CONDITION = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['group'] },
    match: { type: 'string', enum: ['all', 'any'] },
    conditions: { type: 'array', items: { anyOf: [FIELD_CONDITION, RELATION_CONDITION] } },
  },
  required: ['type', 'match', 'conditions'],
};

const SPEC = {
  type: 'object',
  properties: {
    entity: { type: 'string', enum: Object.keys(ENTITIES) },
    match: { type: 'string', enum: ['all', 'any'] },
    conditions: { type: 'array', items: { anyOf: [FIELD_CONDITION, RELATION_CONDITION, GROUP_CONDITION] } },
    columns: { type: 'array', items: { type: 'string' } },
  },
  required: ['entity', 'match', 'conditions', 'columns'],
};

const REPORT_REPLY = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['report'] },
    assumptions: { type: 'array', items: { type: 'string' } },
    spec: SPEC,
  },
  required: ['kind', 'assumptions', 'spec'],
};

const CLARIFY_REPLY = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['clarify'] },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
  },
  required: ['kind', 'question', 'options'],
};

export const RESPONSE_SCHEMA = { anyOf: [REPORT_REPLY, CLARIFY_REPLY] };
export const REPORT_ONLY_SCHEMA = REPORT_REPLY;

function describeEntity(name, entity, values) {
  const lines = [`## ${name}`, entity.description, 'fields:'];
  for (const [fname, f] of Object.entries(entity.fields)) {
    let t = f.type;
    if (f.type === 'enum' && f.valuesFrom && values[f.valuesFrom]?.length) t = `enum: ${values[f.valuesFrom].join(' | ')}`;
    lines.push(`- ${fname} (${t})${f.description ? ` — ${f.description}` : ''}`);
  }
  lines.push('relations:');
  for (const [rname, r] of Object.entries(entity.relations)) {
    lines.push(`- ${rname} (${r.cardinality} → ${r.target}) — ${r.description}`);
  }
  return lines.join('\n');
}

const EXAMPLES = [
  {
    q: 'Show me all disabled service principals',
    a: { kind: 'report', assumptions: [], spec: { entity: 'account', match: 'all', conditions: [
      { type: 'field', field: 'principalType', op: 'eq', value: 'ServicePrincipal' },
      { type: 'field', field: 'accountEnabled', op: 'eq', value: false },
    ], columns: [] } },
  },
  {
    q: 'Which groups have no owner?',
    a: { kind: 'report', assumptions: [], spec: { entity: 'group', match: 'all', conditions: [
      { type: 'relation', relation: 'owners', quantifier: 'none', match: 'all', conditions: [] },
    ], columns: [] } },
  },
  {
    q: 'Users in Finance that are in a group with Admin in the name. Show name, email and which groups.',
    a: { kind: 'report', assumptions: ['"in Finance" means the department contains Finance.'], spec: { entity: 'user', match: 'all', conditions: [
      { type: 'field', field: 'department', op: 'contains', value: 'Finance' },
      { type: 'relation', relation: 'memberOf', quantifier: 'some', match: 'all', conditions: [
        { type: 'field', field: 'displayName', op: 'contains', value: 'Admin' },
      ] },
    ], columns: ['displayName', 'email', 'memberOf.names'] } },
  },
  {
    q: 'guests created more than half a year ago that never accepted the invite',
    a: { kind: 'report', assumptions: ['Half a year = 180 days.'], spec: { entity: 'user', match: 'all', conditions: [
      { type: 'field', field: 'userType', op: 'eq', value: 'Guest' },
      { type: 'field', field: 'createdDateTime', op: 'olderThanDays', value: 180 },
      { type: 'field', field: 'externalUserState', op: 'eq', value: 'PendingAcceptance' },
    ], columns: [] } },
  },
  {
    q: 'people with the Exchange Administrator role',
    a: { kind: 'report', assumptions: ['A role is an Entra directory role, held via access.'], spec: { entity: 'user', match: 'all', conditions: [
      { type: 'relation', relation: 'access', quantifier: 'some', match: 'all', conditions: [
        { type: 'field', field: 'resourceType', op: 'eq', value: 'EntraDirectoryRole' },
        { type: 'field', field: 'displayName', op: 'contains', value: 'Exchange Administrator' },
      ] },
    ], columns: [] } },
  },
  {
    q: 'security groups that have more than 20 members or that can be assigned to roles',
    a: { kind: 'report', assumptions: ['The "or" applies to the member count and role-assignable conditions.'], spec: { entity: 'group', match: 'all', conditions: [
      { type: 'field', field: 'securityEnabled', op: 'eq', value: true },
      { type: 'group', match: 'any', conditions: [
        { type: 'field', field: 'memberCount', op: 'gt', value: 20 },
        { type: 'field', field: 'roleAssignable', op: 'eq', value: true },
      ] },
    ], columns: ['displayName', 'memberCount', 'roleAssignable'] } },
  },
  {
    q: 'Who owns applications? include what they own',
    a: { kind: 'report', assumptions: [], spec: { entity: 'account', match: 'all', conditions: [
      { type: 'relation', relation: 'owns', quantifier: 'some', match: 'all', conditions: [
        { type: 'field', field: 'resourceType', op: 'eq', value: 'Application' },
      ] },
    ], columns: ['displayName', 'principalType', 'owns.names'] } },
  },
  {
    q: 'Show everyone with access to Salesforce',
    a: { kind: 'clarify', question: 'How is Salesforce access granted here?', options: [
      'Members of groups with "Salesforce" in the name',
      'Accounts with any access to a resource with "Salesforce" in the name (groups, app roles, permissions)',
    ] },
  },
  {
    q: 'users that do not have MFA enabled',
    a: { kind: 'clarify', question: 'There is no MFA / authentication-method information in the fields I can use, so I cannot build this report. Which field holds MFA status in your data?', options: [
      'Show all enabled users instead',
      'I will ask an administrator to import MFA data',
    ] },
  },
];

/** @param {object} values known enum values keyed by catalog valuesFrom */
export function buildSystemPrompt(values) {
  const ops = Object.entries(OPERATORS_BY_TYPE).map(([t, list]) => `- ${t}: ${list.join(', ')}`).join('\n');
  const examples = EXAMPLES.map(e => `Request: ${e.q}\nReply: ${JSON.stringify(e.a)}`).join('\n\n');
  return `You translate an analyst's request into a JSON report definition for Identity Atlas, an identity and access governance tool. You never write SQL and you never see data. Reply with JSON only.

# Entities
${Object.entries(ENTITIES).map(([n, e]) => describeEntity(n, e, values)).join('\n\n')}

# Operators per field type
${ops}
Boolean values are true/false. withinLastDays / olderThanDays take a number of days. isEmpty / isNotEmpty take value null.

# Conditions
- field:    {"type":"field","field":"...","op":"...","value":...}
- relation: {"type":"relation","relation":"...","quantifier":"some"|"none","match":"all","conditions":[field conditions on the RELATED entity]}
  "has no manager" = relation manager, quantifier none, no conditions. "manager is disabled" = relation manager, quantifier some, condition accountEnabled eq false.
- group:    {"type":"group","match":"any","conditions":[...]} — use for an OR inside an AND (or the reverse).

# Columns
Field names of the entity; "manager.displayName" style for the manager; "<relation>.names" or "<relation>.count" for the other relations. Use [] when the user did not ask for specific columns; always include displayName when you do list columns.

# Rules
1. Pick the entity from the noun: users / people / employees / guests → user. groups → group. Accounts in general, or service principals, managed identities, AI agents → account with a principalType condition. Roles, applications, permissions, business roles, Azure resources → resource with a resourceType condition.
2. "guests" / "external users" = userType Guest. "disabled" = accountEnabled false; "active"/"enabled" = accountEnabled true. "roles" = resourceType EntraDirectoryRole unless the user means business roles; holding a role = the access relation, never memberOf.
2b. When the request joins conditions with "or" ("either ... or"), put exactly those conditions in a group with match "any"; everything else stays outside that group.
3. A name fragment the user mentions (like "HAMIS" or "LIC") is a displayName contains filter, unless they say it must match exactly.
4. Reply with {"kind":"clarify"} ONLY when the request is genuinely ambiguous in a way that changes which rows are returned. Give 2-3 short options. Never ask about columns, sorting or formatting. When the user has answered a question or says to use your judgement, reply with a report.
5. Record every interpretation choice you made as a short sentence in "assumptions".
6. When the user refines an earlier report, reply with the COMPLETE updated definition.
7. Use ONLY the fields and relations listed above. When the request depends on information that is not listed (for example last sign-in, MFA, licence cost, passwords), do NOT substitute a different field: reply with {"kind":"clarify"} that names the missing information and asks which field holds it.

# Examples
${examples}`;
}
