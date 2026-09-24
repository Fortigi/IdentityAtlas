// Natural-language reports — corrections about sign-in activity and guests
// that need no model round. Sibling of autofix.js, kept apart so that file
// stays readable; the service chains these the same way.
//
// WHY THESE ARE DETERMINISTIC. "Guest accounts that have not signed in for 90
// days" is one of the first questions anybody asks, and there is exactly one
// right definition for it in this catalog: userType Guest, daysSinceLastSignIn
// gt 90. The prompt says so (rule 2c), and the model still writes lastSignIn
// withinLastDays 90 (the accounts that DID sign in), or loses the guest part
// on the way, often enough that the question failed in a live test. A reading
// with one right answer is not left to a probabilistic step.

import { ENTITIES } from './catalog.js';

const isUserReport = (spec) => ENTITIES[spec?.entity]?.detailKind === 'user';

// "90 dagen", "3 maanden", "two weeks", "een jaar", "a quarter".
const UNIT_DAYS = { dag: 1, dagen: 1, day: 1, days: 1, week: 7, weken: 7, weeks: 7, maand: 30, maanden: 30, month: 30, months: 30, kwartaal: 90, quarter: 90, jaar: 365, year: 365, years: 365 };
const SMALL_NUMBERS = { een: 1, één: 1, a: 1, an: 1, one: 1, twee: 2, two: 2, drie: 3, three: 3, vier: 4, four: 4, vijf: 5, five: 5, zes: 6, six: 6, half: 0.5 };
const WINDOW_RE = /\b(\d+|een|één|a|an|one|twee|two|drie|three|vier|four|vijf|five|zes|six|half)\s+(dagen|dag|days|day|weken|week|weeks|maanden|maand|months|month|kwartaal|quarter|jaar|year|years)\b/i;

/** The number of days a phrase like "de laatste 90 dagen" / "three months" names, else null. */
export function daysIn(text) {
  const m = String(text ?? '').match(WINDOW_RE);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : SMALL_NUMBERS[m[1].toLowerCase()];
  const unit = UNIT_DAYS[m[2].toLowerCase()];
  return n && unit ? Math.round(n * unit) : null;
}

const NOT_SIGNED_IN_RE = /\b(niet|geen|not|no|never|nooit|haven't|hasn't|without)\b[^.?!]{0,40}?\b(ingelogd|aangemeld|inlog|aanmeld|sign(ed|s)? ?in|logged ?in|log ?in|logon|aanmelding|sign-ins?)\b|\b(ingelogd|aangemeld|signed ?in|logged ?in)\b[^.?!]{0,12}\b(niet|nooit|never|not)\b|\binacti(ef|ve|eve)\b/i;
const NEVER_RE = /\b(nooit|never|nog nooit|not once|no sign-?ins? at all)\b/i;
const SIGN_IN_FIELDS = new Set(['lastSignIn', 'daysSinceLastSignIn', 'signInDataCollected']);

/**
 * "Not signed in for N days" — one definition, written in.
 *
 * On a report of accounts whose question says somebody has NOT signed in
 * within a stated window, the sign-in conditions become exactly
 * `daysSinceLastSignIn gt N`; whatever the model wrote about sign-in at the top
 * level (a reversed window, lastSignIn isEmpty, the collection date) is
 * replaced. "Never signed in" becomes lastSignIn isEmpty with
 * signInDataCollected isNotEmpty, as prompt rule 2c asks. Questions that
 * mention sign-in without a negation ("who signed in this week") are left
 * alone — those really do want the recent ones.
 * @returns {{ spec: object, notes: string[] }}
 */
export function notSignedInFor(spec, question) {
  const text = String(question ?? '');
  if (!isUserReport(spec) || !NOT_SIGNED_IN_RE.test(text)) return { spec, notes: [] };
  const never = NEVER_RE.test(text);
  const days = daysIn(text);
  if (!never && !days) return { spec, notes: [] };
  const wanted = never
    ? [{ type: 'field', field: 'lastSignIn', op: 'isEmpty' }, { type: 'field', field: 'signInDataCollected', op: 'isNotEmpty' }]
    : [{ type: 'field', field: 'daysSinceLastSignIn', op: 'gt', value: days }];
  const current = (spec.conditions ?? []).filter(c => c.type === 'field' && SIGN_IN_FIELDS.has(c.field));
  if (JSON.stringify(current) === JSON.stringify(wanted)) return { spec, notes: [] };
  const rest = (spec.conditions ?? []).filter(c => !(c.type === 'field' && SIGN_IN_FIELDS.has(c.field)));
  return {
    spec: { ...spec, match: spec.match === 'any' && rest.length ? spec.match : 'all', conditions: [...rest, ...wanted] },
    notes: [never
      ? 'Read "never signed in" as: no sign-in on record, for accounts whose system reports sign-ins.'
      : `Read "not signed in for ${days} days" as: last sign-in more than ${days} days before the sign-in data was collected.`],
  };
}

const GUEST_RE = /\b(gast(en|accounts?|gebruikers?)?|guests?( accounts?| users?)?|externe (gebruikers?|accounts?)|external (users?|accounts?)|b2b(-| )?(users?|gasten|accounts?)?)\b/i;

/**
 * "Guest accounts that …" on a report of accounts that says nothing about
 * the account type: userType Guest is added. The word is in the question,
 * the glossary maps it, and a list of every account where guests were asked
 * for answers a different question. A report where the definition already
 * says anything about userType (Guest, Member, not Guest) is left as written,
 * and so is a report of anything other than accounts ("groups with guests in
 * them" is about groups; its guest condition sits in the members relation).
 * @returns {{ spec: object, notes: string[] }}
 */
export function guestsWhenAsked(spec, question) {
  if (!isUserReport(spec) || !GUEST_RE.test(String(question ?? ''))) return { spec, notes: [] };
  const saysType = (conditions) => (conditions ?? []).some(c => (c.type === 'field' && c.field === 'userType')
    || (c.type === 'group' && saysType(c.conditions)));
  if (saysType(spec.conditions)) return { spec, notes: [] };
  return {
    spec: { ...spec, match: (spec.conditions ?? []).length ? (spec.match === 'any' ? 'all' : spec.match ?? 'all') : 'all',
      conditions: [...(spec.match === 'any' && (spec.conditions ?? []).length > 1 ? [{ type: 'group', match: 'any', conditions: spec.conditions }] : (spec.conditions ?? [])),
        { type: 'field', field: 'userType', op: 'eq', value: 'Guest' }] },
    notes: ['Read "guests" as: accounts of type Guest.'],
  };
}

// A yes/no question about one person: "heeft Bram de rol Global Administrator?",
// "does bram have global admin", "is anna a member of the finance group", also
// behind a lead-in ("kan je me vertellen of …", "can you check whether …").
const LEAD_IN_RE = /^\s*(?:(?:kan|kun|zou|wil)\s+(?:je|u|jij)\s+(?:me|mij|even|eens|ook)?\s*(?:vertellen|zeggen|nagaan|checken|controleren|kijken|uitzoeken|opzoeken)\s+(?:of|dat)|(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:tell me|check|find out|see|verify|confirm)\s+(?:if|whether)|weet je of|(?:do you know|i wonder|i'd like to know|i want to know)\s+(?:if|whether)|i want to know|ik wil weten of|ik ben benieuwd of)\s+/i;
const YES_NO_RE = /^(?:heeft|is|zit|mag|kan|beschikt|hoort|behoort|does|is|has|have|can|do|did|was)\s+\p{L}/iu;
const LISTING_RE = /\b(welke|which|what|wat|lijst|list|alle|all|hoeveel|how many|wie|who|overzicht|overview|show|toon|laat|geef|give|every|elke|iedereen|everyone)\b/i;

/** Is this a yes/no question about one person holding one thing (not a request for a list)? */
export function isYesNoAboutPerson(question) {
  const whole = String(question ?? '');
  const text = whole.replace(LEAD_IN_RE, '');
  // Behind "…tell me whether" / "…vertellen of" the clause IS a yes/no question,
  // whatever word it starts with (Dutch puts the verb last: "of bram global admin heeft").
  const ledIn = text !== whole;
  return (ledIn || YES_NO_RE.test(text)) && !LISTING_RE.test(text);
}

/**
 * A report of accounts that names the person and nothing else — what a yes/no
 * question comes back as when the model lists everything the person holds
 * instead of checking the one thing asked about.
 */
export function listsEverythingOfPerson(spec) {
  const conditions = spec?.conditions ?? [];
  if (!conditions.length) return false;
  const person = (c) => c.type === 'field' && ['displayName', 'id', 'email', 'userPrincipalName'].includes(c.field);
  if (isUserReport(spec)) return conditions.every(person);
  // The other shape: every role / group / resource one person holds, with the
  // thing asked about not named ("does bram have global admin" as all of
  // bram's directory roles).
  const relations = conditions.filter(c => c.type === 'relation');
  const rest = conditions.filter(c => c.type !== 'relation');
  return relations.length === 1 && ['members', 'owners', 'eligibleMembers'].includes(relations[0].relation)
    && (relations[0].conditions ?? []).length > 0 && relations[0].conditions.every(person)
    && rest.every(c => c.type === 'field' && c.field === 'resourceType');
}

// "In welke access packages zit ik" answered as every resource the caller
// holds (184 rows, five of them access packages): the model wrote the report
// of resources and left the kind out. The words are in the question and the
// glossary maps them; the type is written in.
const PACKAGE_WORDS_RE = /\b(access ?packages?|business ?roles?|bedrijfsrol(len)?|toegangspakket(ten)?|role ?packages?)\b/i;

/**
 * A report of resources whose question says "access package" / "business
 * role" and whose definition says nothing about the resource type gets
 * resourceType BusinessRole. A definition that already names a type (any
 * type) is left alone, and so is any other entity: on a user or group report
 * the same words mean the businessRoles relation (accessPackageAsRelation).
 * @returns {{ spec: object, notes: string[] }}
 */
export function businessRoleTypeWhenAsked(spec, question) {
  if (spec?.entity !== 'resource' || !PACKAGE_WORDS_RE.test(String(question ?? ''))) return { spec, notes: [] };
  const saysType = (conditions) => (conditions ?? []).some(c => (c.type === 'field' && c.field === 'resourceType')
    || (c.type === 'group' && saysType(c.conditions)));
  if (saysType(spec.conditions)) return { spec, notes: [] };
  const type = { type: 'field', field: 'resourceType', op: 'eq', value: 'BusinessRole' };
  const rest = spec.conditions ?? [];
  const conditions = spec.match === 'any' && rest.length > 1 ? [{ type: 'group', match: 'any', conditions: rest }, type] : [...rest, type];
  return { spec: { ...spec, match: 'all', conditions }, notes: ['Read "access package" / "business role" as: resources of type BusinessRole.'] };
}
