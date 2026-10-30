// Context interviews — what the model is asked, per template.
//
//   buildSystemPrompt(template) → string
//   buildUserMessage({ contextName, aliases, template, intervieweeName, interviewedAt, part, parts, text }) → string
//   RESPONSE_SCHEMA — the strict JSON shape of a reply (the model server enforces it)
//
// The model only PROPOSES (decision principle B3): every claim it makes is
// checked (claims.js: the quote must be verbatim), matched to people
// (subjects.js) and turned into role suggestions by fixed rules (roles.js), and
// none of it is written to the context until an analyst confirms it.
//
// The relation of a role claim is asked for in words the rules can read:
//   owner     the subject owns / is accountable for it ("I'm the owner")
//   notOwner  the subject says they are NOT the owner ("it isn't mine")
//   dayToDay  the subject does the daily work ("Piet does the day-to-day")
//   delegate  the subject stands in for the owner (backup, deputy, delegate)
//   member    the subject works in / on it, no responsibility stated
//   other     anything else
// A membership claim says whether the person is in it now (current, joined,
// rejoined — back after an earlier stint) or not any more (former, left); an alias claim is another name of the context.
// Every claim carries the model's relevance tier, which relevance.js may overrule.

import { CLAIM_KINDS, RELATIONS, MAX_ATTRIBUTE, MEMBERSHIP_STATUSES, RELEVANCE } from './claims.js';

export const MAX_CLAIMS_PER_PART = 25;
// What the interviewee is called in a reply, whoever they are.
export const INTERVIEWEE = 'interviewee';

const nullableString = { type: ['string', 'null'] };
export const RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      maxItems: MAX_CLAIMS_PER_PART,
      items: {
        type: 'object',
        required: ['kind', 'value', 'quote'],
        properties: {
          kind: { type: 'string', enum: CLAIM_KINDS },
          subject: nullableString,
          attribute: { type: ['string', 'null'], maxLength: MAX_ATTRIBUTE },
          relation: { type: ['string', 'null'], enum: [...RELATIONS, null] },
          membership: { type: ['string', 'null'], enum: [...MEMBERSHIP_STATUSES, null] },
          value: { type: 'string', maxLength: 600 },
          periodFrom: nullableString,
          periodTo: nullableString,
          periodText: nullableString,
          quote: { type: 'string', maxLength: 600 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          relevance: { type: 'string', enum: RELEVANCE },
        },
      },
    },
  },
});

// What is worth knowing: what identity and access governance runs on. The same
// for every template, then what differs per template.
const PURPOSE = `Only what matters for identity and access governance — who should have access to what, and why:
- people: who works in or on it, in which role, and how that changed over time; who joined, who LEFT, who used to work on it (membership);
- who owns it or answers for it, who does the daily work, who stands in (role);
- other names it goes by ("also known as", "or just", an abbreviation) (alias);
- the systems and applications it uses;
- facts that change who may have access: sector, contract or customer since, regulation and compliance, sensitive data, outsourcing (property).
SKIP small talk, greetings, opinions, anecdotes and general facts that change nothing about access (the weather, the office, a nice colleague, how busy it is).`;

// What is worth knowing differs per template.
const FOCUS = {
  OrganizationalUnit: `The subject is an organisational unit: a customer, a department, a team or a project.
Worth a claim: what the unit is and does (description); facts such as its sector, location, customer or contract since, the systems it works in (property, with a short attribute name such as "sector", "customerSince" or "systems"); who leads or answers for it, who works there and in which role (role); how a person's role there changed over time — junior, became architect (roleHistory, one claim per period, with the period); who is in it now, who joined and who left or worked on it before (membership).`,
  LogicalApplication: `The subject is an application.
Worth a claim: what the application is for (description); its users, the data it holds, the business process it supports, its vendor or hosting (property, with a short attribute name such as "users", "data" or "vendor"); who owns it and who does the daily work, backup or delegate (role); how a person's role around it changed over time (roleHistory); who works with it now and who used to (membership).`,
};

const RULES = `Reply with JSON only: {"claims": [...]}. Each claim:
- kind: ${CLAIM_KINDS.map(k => `"${k}"`).join(', ')}.
- subject: for role, roleHistory and membership, the person's name exactly as said, or "${INTERVIEWEE}" when it is the interviewee speaking about themselves ("I", "me", "ik"). null for description, property and alias.
- relation (role and roleHistory only): "owner" (owns it / is accountable), "notOwner" (says they are not the owner), "dayToDay" (does the daily work, handles it), "delegate" (backup, deputy, stands in), "member" (works there), "other".
- membership (membership only): "current" (is in it now), "former" (used to be, worked on it before), "joined", "left", "rejoined" (was in it before, left, and is back — "came back as architect", "is weer terug").
- attribute (property only): a short attribute name.
- value: the claim in one short sentence or phrase; for roleHistory the role held ("junior developer", "architect for the CCoE"); for membership what was said ("left the account", "worked on it in the early years"); for alias the other name alone ("HA").
- periodFrom / periodTo: "YYYY", "YYYY-MM" or "YYYY-MM-DD" when the interview gives one, else null. periodText: the period as said ("early on", "now"), else null.
- quote: the words from the transcript the claim rests on, copied EXACTLY, a sentence or less. No quote, no claim.
- confidence: 0 to 1, how clearly the transcript states it.
- relevance: "high" when it matters for who should have access to what (the list above), "low" when it is true but changes nothing about access.
"X just left" and "X and Y worked on it in the early years" are membership claims (left; former), one per person.
When the interviewee says someone else owns it ("I'm not the owner, Y is"), give two claims: notOwner for "${INTERVIEWEE}" and owner for Y.
Someone who IS involved now ("is since a year involved", "does the data work") is current, not former — read the whole sentence before you decide.
When the speaker calls the unit or application by another name than the one given above (and not one of its known other names) — "the Harbour Office" for "HarbourOfficeNL" — give an alias claim with that name.
Only claims the transcript states. Do not guess; do not repeat a claim.`;

export function buildSystemPrompt(template) {
  return `You read the transcript of an interview and list what it says as claims, for Identity Atlas, an identity governance tool.
${PURPOSE}
${FOCUS[template] || FOCUS.OrganizationalUnit}
${RULES}`;
}

export function buildUserMessage({ contextName, aliases = [], template, intervieweeName, interviewedAt, part = 1, parts = 1, text }) {
  const kind = template === 'LogicalApplication' ? 'Application' : 'Unit';
  const known = aliases.length ? ` (also known as ${aliases.map(a => JSON.stringify(a)).join(', ')})` : '';
  return [
    `${kind}: ${JSON.stringify(contextName)}${known}`,
    `Interviewee: ${JSON.stringify(intervieweeName)} (interviewed on ${interviewedAt})`,
    parts > 1 ? `Transcript, part ${part} of ${parts}:` : 'Transcript:',
    text,
  ].join('\n');
}
