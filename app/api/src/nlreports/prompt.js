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

import { ENTITIES, GLOSSARY, OPERATORS_BY_TYPE, OPERATORS } from './catalog.js';
import { MEASURES } from './compare.js';
import { MAX_COLUMNS, MAX_CONDITIONS } from './spec.js';

const allFieldNames = [...new Set(Object.values(ENTITIES).flatMap(e => Object.keys(e.fields)))];
const allRelationNames = [...new Set(Object.values(ENTITIES).flatMap(e => Object.keys(e.relations)))];

// Every array and every free-text string in the reply is bounded, because the
// grammar is the only thing that stops a small model at temperature 0 from
// repeating itself. Unbounded, it did: asked for "groups with more than 10 members,
// biggest first", the model wrote the right condition and then listed the same ten
// columns over and over until the 1,200-token cap — 570 s of CPU, and a reply that
// was no longer valid JSON. The array limits are the validator's own, so the
// grammar never allows what validation would reject anyway; the prose limits are
// generous next to anything a useful reply says.
export const REPLY_LIMITS = {
  conditions: MAX_CONDITIONS,
  columns: MAX_COLUMNS,
  assumptions: 5,
  options: 6,
  prose: 300,      // an assumption, a clarifying question
  option: 120,     // one clarifying option
  value: 200,      // a text value or a referenced record's name
};
const boundedList = (items, maxItems) => ({ type: 'array', items, maxItems });

const FIELD_CONDITION = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['field'] },
    field: { type: 'string', enum: allFieldNames },
    op: { type: 'string', enum: Object.keys(OPERATORS) },
    // Spelled out as anyOf rather than a type list, so the length limit is attached
    // to the string branch — a type list gives the grammar nowhere to put it.
    value: { anyOf: [
      { type: 'string', maxLength: REPLY_LIMITS.value },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
    ] },
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
    conditions: boundedList(FIELD_CONDITION, REPLY_LIMITS.conditions),
  },
  required: ['type', 'relation', 'quantifier', 'match', 'conditions'],
};

const COMPARE_CONDITION = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['compare'] },
    relation: { type: 'string', enum: allRelationNames },
    measure: { type: 'string', enum: Object.keys(MEASURES) },
    minSimilarity: { type: 'number' },
    reference: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: Object.keys(ENTITIES) },
        name: { type: 'string', maxLength: REPLY_LIMITS.value },
      },
      required: ['entity', 'name'],
    },
  },
  required: ['type', 'relation', 'measure', 'minSimilarity', 'reference'],
};

const GROUP_CONDITION = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['group'] },
    match: { type: 'string', enum: ['all', 'any'] },
    conditions: boundedList({ anyOf: [FIELD_CONDITION, RELATION_CONDITION, COMPARE_CONDITION] }, REPLY_LIMITS.conditions),
  },
  required: ['type', 'match', 'conditions'],
};

const SPEC = {
  type: 'object',
  properties: {
    entity: { type: 'string', enum: Object.keys(ENTITIES) },
    match: { type: 'string', enum: ['all', 'any'] },
    conditions: boundedList({ anyOf: [FIELD_CONDITION, RELATION_CONDITION, COMPARE_CONDITION, GROUP_CONDITION] }, REPLY_LIMITS.conditions),
    columns: boundedList({ type: 'string', maxLength: REPLY_LIMITS.option }, REPLY_LIMITS.columns),
  },
  required: ['entity', 'match', 'conditions', 'columns'],
};

const REPORT_REPLY = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['report'] },
    assumptions: boundedList({ type: 'string', maxLength: REPLY_LIMITS.prose }, REPLY_LIMITS.assumptions),
    spec: SPEC,
  },
  required: ['kind', 'assumptions', 'spec'],
};

const CLARIFY_REPLY = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['clarify'] },
    question: { type: 'string', maxLength: REPLY_LIMITS.prose },
    options: boundedList({ type: 'string', maxLength: REPLY_LIMITS.option }, REPLY_LIMITS.options),
  },
  required: ['kind', 'question', 'options'],
};

export const RESPONSE_SCHEMA = { anyOf: [REPORT_REPLY, CLARIFY_REPLY] };
export const REPORT_ONLY_SCHEMA = REPORT_REPLY;

function describeEntity(name, entity) {
  const lines = [`## ${name}`, entity.description, 'fields:'];
  for (const [fname, f] of Object.entries(entity.fields)) {
    lines.push(`- ${fname} (${f.type})${f.description ? ` — ${f.description}` : ''}`);
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
    q: 'users with the Exchange Administrator role',
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
    q: 'users with exactly the same group memberships as Jan de Vries',
    a: { kind: 'report', assumptions: ['"Jan de Vries" is a user.'], spec: { entity: 'user', match: 'all', conditions: [
      { type: 'compare', relation: 'memberOf', measure: 'identical', minSimilarity: 100, reference: { entity: 'user', name: 'Jan de Vries' } },
    ], columns: [] } },
  },
  {
    q: 'groups whose members overlap at least 70 percent with the Finance Team group',
    a: { kind: 'report', assumptions: [], spec: { entity: 'group', match: 'all', conditions: [
      { type: 'compare', relation: 'members', measure: 'similar', minSimilarity: 70, reference: { entity: 'group', name: 'Finance Team' } },
    ], columns: [] } },
  },
  {
    q: 'users that do not have MFA enabled',
    a: { kind: 'clarify', question: 'There is no MFA / authentication-method information in the fields I can use, so I cannot build this report. Which field holds MFA status in your data?', options: [
      'Show all enabled users instead',
      'I will ask an administrator to import MFA data',
    ] },
  },
];

/**
 * The values that exist in THIS deployment (account types, resource types, system
 * names). Sent with each question instead of baked into the system prompt, so the
 * system prompt — and therefore the saved prompt cache — is the same for every
 * deployment of a release and can be prepared once at build time.
 * @param {object} values known enum values keyed by catalog valuesFrom
 */
export function buildValuesBlock(values) {
  const byList = new Map(); // valuesFrom → { fields, list } — one line per list, not per entity
  for (const entity of Object.values(ENTITIES)) {
    for (const [fname, f] of Object.entries(entity.fields)) {
      if (f.type !== 'enum' || !f.valuesFrom || !values[f.valuesFrom]?.length) continue;
      if (!byList.has(f.valuesFrom)) byList.set(f.valuesFrom, { fields: new Set(), list: values[f.valuesFrom] });
      byList.get(f.valuesFrom).fields.add(fname);
    }
  }
  if (byList.size === 0) return '';
  const lines = [...byList.values()].map(v => `- ${[...v.fields].join(' / ')}: ${v.list.join(' | ')}`);
  return `Values that exist in this deployment (use these exact strings):\n${lines.join('\n')}`;
}

/** The system prompt. Identical for every deployment of a release — no data in it. */
export function buildSystemPrompt() {
  const ops = Object.entries(OPERATORS_BY_TYPE).map(([t, list]) => `- ${t}: ${list.join(', ')}`).join('\n');
  const examples = EXAMPLES.map(e => `Request: ${e.q}\nReply: ${JSON.stringify(e.a)}`).join('\n\n');
  return `You translate an analyst's request into a JSON report definition for Identity Atlas, an identity and access governance tool. You never write SQL and you never see data. Reply with JSON only.

# Entities
${Object.entries(ENTITIES).map(([n, e]) => describeEntity(n, e)).join('\n\n')}

# Glossary — these words mean the same thing
${GLOSSARY.map(g => `- ${g.terms.map(t => `"${t}"`).join(', ')} → ${g.means}`).join('\n')}

# Operators per field type
${ops}
Boolean values are true/false. withinLastDays / olderThanDays take a number of days. isEmpty / isNotEmpty take value null.

# Conditions
- field:    {"type":"field","field":"...","op":"...","value":...}
- relation: {"type":"relation","relation":"...","quantifier":"some"|"none","match":"all","conditions":[field conditions on the RELATED entity]}
  "has no manager" = relation manager, quantifier none, no conditions. "manager is disabled" = relation manager, quantifier some, condition accountEnabled eq false.
- group:    {"type":"group","match":"any","conditions":[...]} — use for an OR inside an AND (or the reverse).
- compare:  {"type":"compare","relation":"members","measure":"identical","minSimilarity":100,"reference":{"entity":"resource","name":"exact name"}}
  Compares the set each row reaches over a relation (members, memberOf, access, owners, owns, …) with the same set of ONE named record.
  measure: identical = exactly the same set · containsAll = has everything the reference has (maybe more) · within = has only things the reference also has · similar = overlap of at least minSimilarity percent.
  The comparison columns (similarity, what is only here, what is missing) are added automatically.

# Columns
Field names of the entity; "manager.displayName" style for the manager; "<relation>.names" or "<relation>.count" for the other relations. Use [] when the user did not ask for specific columns; always include displayName when you do list columns.

# Rules
1. Pick the entity from the noun, using the glossary: persons → identity; users / accounts / guests → user; groups → group. Service principals, managed identities, AI agents, or accounts of every kind → account with a principalType condition. Roles, applications, permissions, business roles, Azure resources → resource with a resourceType condition. When a question about persons is really about their group memberships, access or ownership, use user.
2. "guests" / "external users" = userType Guest. "disabled" = accountEnabled false; "active"/"enabled" = accountEnabled true. "roles" = resourceType EntraDirectoryRole unless the user means business roles; holding a role = the access relation, never memberOf.
2b. When the request joins conditions with "or" ("either ... or"), put exactly those conditions in a group with match "any"; everything else stays outside that group.
3. A name fragment the user mentions (like "HAMIS" or "LIC") is a displayName contains filter, unless they say it must match exactly.
4. Reply with {"kind":"clarify"} ONLY when the request is genuinely ambiguous in a way that changes which rows are returned. Give 2-3 short options. Never ask about columns, sorting or formatting. When the user has answered a question or says to use your judgement, reply with a report.
5. Record every interpretation choice you made as a short sentence in "assumptions".
6. When the user refines an earlier report, reply with the COMPLETE updated definition.
7. Questions that compare sets — "the same members as", "the same access as", "has everything X has", "similar to", "overlaps with" — use a compare condition. Put the name exactly as the user wrote it in reference.name; a business role or access package is entity resource. "same" = identical, "mostly the same / similar / overlap" = similar with minSimilarity 80 unless the user gives a percentage. Membership of a business role itself ("part of / in business role X") is the businessRoles relation with a displayName condition.
8. Use ONLY the fields and relations listed above. When the request depends on information that is not listed (for example last sign-in, MFA, licence cost, passwords), do NOT substitute a different field: reply with {"kind":"clarify"} that names the missing information and asks which field holds it.

# Examples
${examples}`;
}
