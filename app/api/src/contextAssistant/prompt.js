// Context assistant — system prompt and reply grammar.
//
// The model's whole job is a word cloud: given an analyst's description ("groups around
// het inkoopproces"), propose the words that would appear in the names and descriptions
// of the groups that belong to it. The words are then searched for deterministically
// (contexts/recipe/), exactly as custom reports turn "Wim" into a name lookup — the
// model never sees a group, a name or a member.
//
// The prompt is byte-stable (no deployment data), so the report generator can keep a
// saved prompt cache of it next to the report prompt's. It is kept short on purpose:
// on a CPU, reading the prompt is most of the wait.

export const REPLY_LIMITS = {
  terms: 15,
  moreTerms: 10,
  term: 40,
  name: 80,
  notes: 3,
  note: 200,
  question: 300,
  options: 4,
  option: 120,
};

export const TERM_REASONS = ['name', 'synonym', 'translation', 'abbreviation', 'activity', 'system', 'related'];

const boundedList = (items, maxItems) => ({ type: 'array', items, maxItems });

// Every array and string is bounded: the grammar is the only thing that stops a small
// model at temperature 0 from repeating itself until the token cap (see nlreports/prompt.js).
const TERM = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: REPLY_LIMITS.term },
    why: { type: 'string', enum: TERM_REASONS },
  },
  required: ['text', 'why'],
};

const termsReply = (maxTerms) => ({
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['terms'] },
    name: { type: 'string', maxLength: REPLY_LIMITS.name },
    terms: boundedList(TERM, maxTerms),
    notes: boundedList({ type: 'string', maxLength: REPLY_LIMITS.note }, REPLY_LIMITS.notes),
  },
  required: ['kind', 'name', 'terms', 'notes'],
});

const CLARIFY_REPLY = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['clarify'] },
    question: { type: 'string', maxLength: REPLY_LIMITS.question },
    options: boundedList({ type: 'string', maxLength: REPLY_LIMITS.option }, REPLY_LIMITS.options),
  },
  required: ['kind', 'question', 'options'],
};

export const TERMS_ONLY_SCHEMA = termsReply(REPLY_LIMITS.terms);
export const RESPONSE_SCHEMA = { anyOf: [TERMS_ONLY_SCHEMA, CLARIFY_REPLY] };
export const MORE_TERMS_SCHEMA = termsReply(REPLY_LIMITS.moreTerms);

const t = (text, why) => ({ text, why });

const EXAMPLES = [
  {
    q: 'Alle groepen rond het inkoopproces',
    a: { kind: 'terms', name: 'Inkoopproces', notes: [], terms: [
      t('inkoop', 'name'), t('procurement', 'translation'), t('purchasing', 'translation'), t('purchase', 'translation'),
      t('bestelling', 'activity'), t('inkooporder', 'activity'), t('crediteuren', 'activity'), t('leverancier', 'related'),
      t('supplier', 'translation'), t('P2P', 'abbreviation'), t('Coupa', 'system'), t('Ariba', 'system'),
    ] },
  },
  {
    q: 'everything to do with HAMIS',
    a: { kind: 'terms', name: 'HAMIS', terms: [t('HAMIS', 'name')], notes: [
      'I do not know HAMIS, so I search for the name exactly as written. Related words can find the names it appears together with.',
    ] },
  },
  {
    q: 'HR groups',
    a: { kind: 'terms', name: 'HR', notes: [], terms: [
      t('HR', 'name'), t('human resources', 'synonym'), t('personeelszaken', 'translation'), t('P&O', 'abbreviation'),
      t('personeel', 'translation'), t('payroll', 'activity'), t('salarisadministratie', 'activity'), t('verzuim', 'activity'),
      t('recruitment', 'activity'), t('werving', 'translation'), t('AFAS', 'system'), t('Youforce', 'system'),
    ] },
  },
  {
    q: 'the important groups',
    a: { kind: 'clarify', question: 'Which subject should the context be about? I need a topic, process, department or system to search for.', options: [
      'A business process (for example purchasing or payroll)',
      'An application or system',
      'A department',
    ] },
  },
];

/** The system prompt. Identical for every deployment of a release — no data in it. */
export function buildContextPrompt() {
  const examples = EXAMPLES.map(e => `Request: ${e.q}\nReply: ${JSON.stringify(e.a)}`).join('\n\n');
  return `You help an analyst of Identity Atlas, an identity and access governance tool, collect the groups that belong to one subject: a business process, an application, a department or a project. You never see the groups. You propose the search terms — the words that would appear in the NAMES and DESCRIPTIONS of those groups — and the terms are then searched for. Reply with JSON only.

# Rules
1. Start with the analyst's own key word, exactly as written. Then add what a group name in a Dutch or international organisation would contain: English and Dutch variants, synonyms, common abbreviations, the activities of the process, and well-known systems used for it.
2. Usually 6 to 12 terms. When the subject is a single name or abbreviation you do not recognise, return just that name and say so in notes — never invent what it stands for.
3. A term is one word or a short phrase of at most 3 words, as it would be written in a group name. No sentences.
4. Never use words that appear in the names of groups of every subject: admin, admins, users, members, owners, group, team, app, all, read, write, prod, test, beheer, beheerders, gebruikers, medewerkers, afdeling, department.
5. "why" says where a term comes from: name (the analyst's word), synonym, translation, abbreviation, activity (a step or document of the process), system (an application used for it), related.
6. "name" is a short name for the context, in the analyst's language.
7. Reply {"kind":"clarify"} only when the request names no subject at all. Give 2-3 short options.
8. When you are told which terms the analyst kept and dropped, propose only NEW terms: like the kept ones, unlike the dropped ones.

# Examples
${examples}`;
}

/** The follow-up message for "suggest more terms". */
export function buildMoreTermsMessage(question, recipe) {
  const kept = recipe.terms.filter(x => x.state === 'accepted').map(x => x.text);
  const dropped = recipe.terms.filter(x => x.state !== 'accepted').map(x => x.text);
  return [
    `Request: ${question}`,
    `Terms the analyst kept: ${kept.length ? kept.join(', ') : '(none)'}`,
    `Terms the analyst dropped: ${dropped.length ? dropped.join(', ') : '(none)'}`,
    `Propose up to ${REPLY_LIMITS.moreTerms} NEW terms that are not in either list.`,
  ].join('\n');
}
