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
  // Two short assumptions, not five long ones: on the CPU box this runs on
  // every token is close to a second, and a reply that explained itself in
  // three sentences of prose spent longer on the prose than on the definition.
  assumptions: 2,
  options: 6,
  prose: 160,      // an assumption, a clarifying question
  option: 120,     // one clarifying option
  value: 200,      // a text value or a referenced record's name
};
const boundedList = (items, maxItems) => ({ type: 'array', items, maxItems });

// The reply grammar is built per question, because the field names it allows are
// not the same for every question: the catalog's own names always, plus the
// handful of this deployment's `extendedAttributes` fields that the question
// actually named (extFields.js). Everything else about it — and the whole system
// prompt — stays identical for every deployment of a release, which is what lets
// the prompt cache be prepared once at build time.
const fieldCondition = (fieldNames) => ({
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['field'] },
    field: { type: 'string', enum: fieldNames },
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
});

const relationCondition = (fieldNames) => ({
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['relation'] },
    relation: { type: 'string', enum: allRelationNames },
    quantifier: { type: 'string', enum: ['some', 'none'] },
    match: { type: 'string', enum: ['all', 'any'] },
    conditions: boundedList(fieldCondition(fieldNames), REPLY_LIMITS.conditions),
  },
  required: ['type', 'relation', 'quantifier', 'match', 'conditions'],
});


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

const groupCondition = (fieldNames) => ({
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['group'] },
    match: { type: 'string', enum: ['all', 'any'] },
    conditions: boundedList({ anyOf: [fieldCondition(fieldNames), relationCondition(fieldNames), COMPARE_CONDITION] }, REPLY_LIMITS.conditions),
  },
  required: ['type', 'match', 'conditions'],
});

const specSchema = (fieldNames) => ({
  type: 'object',
  properties: {
    entity: { type: 'string', enum: Object.keys(ENTITIES) },
    match: { type: 'string', enum: ['all', 'any'] },
    conditions: boundedList({ anyOf: [fieldCondition(fieldNames), relationCondition(fieldNames), COMPARE_CONDITION, groupCondition(fieldNames)] }, REPLY_LIMITS.conditions),
    columns: boundedList({ type: 'string', maxLength: REPLY_LIMITS.option }, REPLY_LIMITS.columns),
    // Deliberately NOT in `required`: a reply that must always carry
    // "groupBy":null spends tokens on every answer and puts the idea of grouping
    // in front of a small model that was not asked for it.
    groupBy: { type: 'string', enum: fieldNames },
  },
  required: ['entity', 'match', 'conditions', 'columns'],
});

const reportReply = (fieldNames) => ({
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['report'] },
    assumptions: boundedList({ type: 'string', maxLength: REPLY_LIMITS.prose }, REPLY_LIMITS.assumptions),
    spec: specSchema(fieldNames),
  },
  required: ['kind', 'assumptions', 'spec'],
});


const CLARIFY_REPLY = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['clarify'] },
    question: { type: 'string', maxLength: REPLY_LIMITS.prose },
    options: boundedList({ type: 'string', maxLength: REPLY_LIMITS.option }, REPLY_LIMITS.options),
  },
  required: ['kind', 'question', 'options'],
};

// A request the assistant should not answer at all: not about the data, or
// asking for a change. One sentence back, never a report. Not in the
// report-only grammar: a caller who has answered two clarifications and is
// still asking about access has earned a report.
const DECLINE_REPLY = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['decline'] },
    reason: { type: 'string', maxLength: REPLY_LIMITS.prose },
  },
  required: ['kind', 'reason'],
};

function buildSchemas(fieldNames) {
  const report = reportReply(fieldNames);
  return { response: { anyOf: [report, CLARIFY_REPLY, DECLINE_REPLY] }, reportOnly: report };
}

// Most questions name no attribute of their own, so the grammar they are answered
// under is the same object every time — built once, here.
const DEFAULT_SCHEMAS = buildSchemas(allFieldNames);

/**
 * The two reply grammars for one question.
 * @param {string[]} [extraFieldNames] discovered field names this question may use
 * @returns {{ response: object, reportOnly: object }}
 */
export function buildReplySchemas(extraFieldNames = []) {
  return extraFieldNames.length ? buildSchemas([...allFieldNames, ...extraFieldNames]) : DEFAULT_SCHEMAS;
}

export const RESPONSE_SCHEMA = DEFAULT_SCHEMAS.response;
export const REPORT_ONLY_SCHEMA = DEFAULT_SCHEMAS.reportOnly;


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
    // Asking for a business-role COLUMN is not asking to leave out the users that
    // have none: the column is added, no condition is.
    q: 'users in Finance, with the business roles they have',
    a: { kind: 'report', assumptions: ['"in Finance" means the department contains Finance.'], spec: { entity: 'user', match: 'all', conditions: [
      { type: 'field', field: 'department', op: 'contains', value: 'Finance' },
    ], columns: ['displayName', 'email', 'businessRoles.names'] } },
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
    q: 'groups that Piet Bakker is in but Jan de Vries is not',
    a: { kind: 'report', assumptions: [], spec: { entity: 'group', match: 'all', conditions: [
      { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'Piet Bakker' }] },
      { type: 'relation', relation: 'members', quantifier: 'none', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'Jan de Vries' }] },
    ], columns: [] } },
  },
  {
    q: 'was Jan de Vries added to or removed from any group in the last 90 days?',
    a: { kind: 'report', assumptions: ['Both additions and removals: no condition on action.'], spec: { entity: 'change', match: 'all', conditions: [
      { type: 'relation', relation: 'account', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'Jan de Vries' }] },
      { type: 'relation', relation: 'resource', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'resourceType', op: 'eq', value: 'Group' }] },
      { type: 'field', field: 'changedAt', op: 'withinLastDays', value: 90 },
    ], columns: [] } },
  },
  {
    q: 'How many users are there per department?',
    a: { kind: 'report', assumptions: [], spec: { entity: 'user', match: 'all', conditions: [], columns: [], groupBy: 'department' } },
  },
  {
    q: 'give me the unique job titles of enabled users, with the number of users for each',
    a: { kind: 'report', assumptions: [], spec: { entity: 'user', match: 'all', conditions: [
      { type: 'field', field: 'accountEnabled', op: 'eq', value: true },
    ], columns: [], groupBy: 'jobTitle' } },
  },
  {
    q: 'Is Trump the president of the United States?',
    a: { kind: 'decline', reason: 'I only build reports on the accounts, groups, access and changes in Identity Atlas.' },
  },
  {
    q: 'remove Jan de Vries from the Finance group',
    a: { kind: 'decline', reason: 'I can only report on access, not change it — ask an administrator to make the change.' },
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

/**
 * Operators the catalog has but the system prompt does not offer.
 *
 * `in` takes a LIST, and `value` in the reply schema has no array branch — so a
 * model told "you may use in" would write `"value": "ASML, Bestuur"`, which
 * coerces to a single value and matches one record whose name contains a comma.
 * A confidently wrong empty answer, from advertising something the grammar
 * cannot express.
 *
 * It is reachable on purpose, just not from here: the Teams bot's per-question
 * context introduces `in` together with `@previous` (teamsbot/followUp.js),
 * which is the only value for it the model can write correctly — one token
 * standing for a list the bot substitutes. Keeping it out of this prompt also
 * keeps the prompt byte-identical across this change, so the cached copy on the
 * model server stays valid and the published accuracy figures still describe
 * what ships.
 */
const NOT_OFFERED_TO_MODEL = new Set(['in']);

/** The system prompt. Identical for every deployment of a release — no data in it. */
export function buildSystemPrompt() {
  const ops = Object.entries(OPERATORS_BY_TYPE)
    .map(([t, list]) => `- ${t}: ${list.filter(op => !NOT_OFFERED_TO_MODEL.has(op)).join(', ')}`)
    .join('\n');
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
2a. A business role / access package is the businessRoles relation of a user, an account or a group — as a condition ("in business role X" = businessRoles some with displayName contains X; "part of / in / via an access package" with no package named = businessRoles some with no conditions; "not via an access package" = businessRoles none) and as the column "businessRoles.names". Never a resourceType BusinessRole condition on a group. Use access only when the request is about access of every kind.
2b. When the request joins conditions with "or" ("either ... or"), put exactly those conditions in a group with match "any"; everything else stays outside that group.
2c. Sign-in: "not signed in for N days" / "inactive for N days" = daysSinceLastSignIn gt N. "never signed in" = lastSignIn isEmpty AND signInDataCollected isNotEmpty (without the second condition, accounts from systems that collect no sign-in data would be listed too).
3. A name fragment the user mentions (like "Finance" or "LIC") is a displayName contains filter, unless they say it must match exactly.
4. Reply with {"kind":"clarify"} ONLY when the request is genuinely ambiguous in a way that changes which rows are returned. Give 2-3 short options. Never ask about columns, sorting or formatting. When the user has answered a question or says to use your judgement, reply with a report.
5. Record an interpretation choice you made as one short sentence in "assumptions" — at most two, and none when there was nothing to choose.
6. When the user refines an earlier report ("only the additions", "alleen de toevoegingen", "and who owns those"), reply with the COMPLETE updated definition: keep every condition of the earlier definition — the same person, the same relation, the same time window — and change only what the refinement says. A refinement never swaps the person the earlier report was about for the person asking.
7. Questions that compare sets — "the same members as", "the same access as", "has everything X has", "similar to", "overlaps with" — use a compare condition. Put the name exactly as the user wrote it in reference.name; a business role or access package is entity resource. "same" = identical, "mostly the same / similar / overlap" = similar with minSimilarity 80 unless the user gives a percentage. Membership of a business role itself ("part of / in business role X") is the businessRoles relation with a displayName condition.
7a. "What X has that Y does not" — "groups I am in that Jan is not", "rights Piet has that Jan lacks" — is NOT a comparison: it is two conditions on the same relation of the group/resource, one with quantifier some for X and one with quantifier none for Y.
8. Use ONLY the fields and relations listed above, plus any attribute named in an "Attributes from this deployment's own data" block in front of the request — those field names start with "ext." and are used exactly as written there. When the request depends on information that is neither listed nor in that block (for example MFA, licence cost, passwords), do NOT substitute a different field: reply with {"kind":"clarify"} that names the missing information and asks which field holds it.
9. Counting per value — ONLY when the request asks "how many … per …", "the number of X per Y", "hoeveel … per …", "a breakdown / distribution by Y", "the unique values of Y with a count" — is "groupBy": "<the Y field>" in the definition, with columns []. The report is then one row per distinct value of that field with the number of records that have it. A request for WHICH records ("which groups", "welke groepen", "list", "show", "aan welke") is never grouped, even when it mentions a field or a count: it lists the records. Group on a field, never on a relation, and never together with a compare condition.
10. A request that is not about the accounts, persons, groups, resources, access or changes described above — general knowledge, news, people outside the directory, opinions, small talk, writing or translation tasks — or that asks to CHANGE anything (add, remove, delete, grant, revoke, reset, disable, invite) is answered with {"kind":"decline","reason":"<one short sentence>"}. You only produce read-only report definitions; never answer such a request with a report or a clarification, and never guess.


# Examples
${examples}`;
}
