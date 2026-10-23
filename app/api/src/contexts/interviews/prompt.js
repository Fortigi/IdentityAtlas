// Context interviews — what the model is asked, per template.
//
//   buildSystemPrompt(template) → string
//   buildUserMessage({ contextName, template, intervieweeName, interviewedAt, part, parts, text }) → string
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

import { CLAIM_KINDS, RELATIONS, MAX_ATTRIBUTE } from './claims.js';

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
          value: { type: 'string', maxLength: 600 },
          periodFrom: nullableString,
          periodTo: nullableString,
          periodText: nullableString,
          quote: { type: 'string', maxLength: 600 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
});

// What is worth knowing differs per template.
const FOCUS = {
  OrganizationalUnit: `The subject is an organisational unit: a customer, a department, a team or a project.
Worth a claim: what the unit is and does (description); facts such as its sector, size, location, customer or contract since, main contact (property, with a short attribute name such as "sector" or "customerSince"); who leads or answers for it, who works there and in which role (role); and how a person's role there changed over time — joined, left, came back, became architect (roleHistory, one claim per period, with the period).`,
  LogicalApplication: `The subject is an application.
Worth a claim: what the application is for (description); its users, the data it holds, the business process it supports, its vendor or hosting (property, with a short attribute name such as "users", "data" or "vendor"); who owns it and who does the daily work, backup or delegate (role); and how a person's role around it changed over time (roleHistory).`,
};

const RULES = `Reply with JSON only: {"claims": [...]}. Each claim:
- kind: ${CLAIM_KINDS.map(k => `"${k}"`).join(', ')}.
- subject: for role and roleHistory, the person's name exactly as said, or "${INTERVIEWEE}" when it is the interviewee speaking about themselves ("I", "me", "ik"). null for description and property.
- relation (role and roleHistory only): "owner" (owns it / is accountable), "notOwner" (says they are not the owner), "dayToDay" (does the daily work, handles it), "delegate" (backup, deputy, stands in), "member" (works there), "other".
- attribute (property only): a short attribute name.
- value: the claim in one short sentence or phrase; for roleHistory the role held ("junior developer", "left", "architect for the CCoE").
- periodFrom / periodTo: "YYYY", "YYYY-MM" or "YYYY-MM-DD" when the interview gives one, else null. periodText: the period as said ("early on", "now"), else null.
- quote: the words from the transcript the claim rests on, copied EXACTLY, a sentence or less. No quote, no claim.
- confidence: 0 to 1, how clearly the transcript states it.
When the interviewee says someone else owns it ("I'm not the owner, Y is"), give two claims: notOwner for "${INTERVIEWEE}" and owner for Y.
Only claims the transcript states. Do not guess; do not repeat a claim.`;

export function buildSystemPrompt(template) {
  return `You read the transcript of an interview and list what it says as claims, for Identity Atlas, an identity governance tool.
${FOCUS[template] || FOCUS.OrganizationalUnit}
${RULES}`;
}

export function buildUserMessage({ contextName, template, intervieweeName, interviewedAt, part = 1, parts = 1, text }) {
  const kind = template === 'LogicalApplication' ? 'Application' : 'Unit';
  return [
    `${kind}: ${JSON.stringify(contextName)}`,
    `Interviewee: ${JSON.stringify(intervieweeName)} (interviewed on ${interviewedAt})`,
    parts > 1 ? `Transcript, part ${part} of ${parts}:` : 'Transcript:',
    text,
  ].join('\n');
}
