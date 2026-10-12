// Organisation knowledge extraction — the vocabulary every stage speaks.
//
// One place for the closed lists (mention types, predicates, modalities, topics),
// the JSON schemas the local model is constrained to, and the validators that
// check its replies. A reply that does not validate is repaired once, then
// dropped — it never reaches the database.
//
// Versions: PIPELINE_VERSION changes when stage order or rules change,
// PROMPT_VERSION when any prompt text changes. Both are stamped on every run
// and exported with the results, so two runs are comparable only when both match.

export const PIPELINE_VERSION = '0.1.0';
export const PROMPT_VERSION = 'ke-2026-10-11.2';

export const SOURCE_FORMATS = Object.freeze(['text', 'markdown', 'srt', 'vtt']);
export const CLASSIFICATIONS = Object.freeze(['internal', 'confidential', 'restricted']);
export const MAX_SOURCE_CHARS = 200_000;

export const MENTION_TYPES = Object.freeze(['person', 'team', 'organisation', 'customer', 'application', 'location', 'role', 'concept']);

// The OrgEntities.entityType a mention is stored as. Prefixed so a mention can
// never share a type with an imported list (the linking engine leaves a rule's own
// type out of OrgEntity targets, and a list called "Customer" must stay findable).
export const MENTION_ENTITY_TYPES = Object.freeze(Object.fromEntries(MENTION_TYPES.map(t => [t, `Mentioned ${t}`])));
export const isMentionEntityType = (entityType) => Object.values(MENTION_ENTITY_TYPES).includes(entityType);

export const PREDICATES = Object.freeze([
  'memberOf',          // person → team / organisation / role (qualifier: "aspirant", "chair", …)
  'formerMemberOf',    // person → team / organisation
  'partOf',            // team → organisation
  'leads',             // person → team
  'responsibleFor',    // person / team → concept / application
  'worksForCustomer',  // person / team / organisation → customer
  'usesApplication',   // person / team / organisation → application
  'hasProperty',       // anything → concept (a rule, a habit, a characteristic)
  'other',             // anything else; qualifier says what
]);

// How a predicate reads in a sentence (the statements panel on detail pages).
export const PREDICATE_LABELS = Object.freeze({
  memberOf: 'is a member of', formerMemberOf: 'was a member of', partOf: 'is part of', leads: 'leads',
  responsibleFor: 'is responsible for', worksForCustomer: 'works for customer', usesApplication: 'uses',
  hasProperty: 'is', other: '—',
});

export const MODALITIES = Object.freeze(['stated', 'implied', 'uncertain', 'correction', 'question']);
export const SUPPORT = Object.freeze(['supported', 'unsupported', 'unclear']);
export const TOPICS = Object.freeze(['governance', 'membership', 'customers', 'applications', 'practices', 'other']);

export const FINDING_KINDS = Object.freeze(['issue', 'question']);
export const FINDING_STATUSES = Object.freeze(['open', 'dismissed', 'resolved']);

export const LIMITS = Object.freeze({
  mentionsPerPassage: 20,
  claimsPerPassage: 20,
  claimsSingle: 60,
  labelChars: 120,
  quoteChars: 400,
  qualifierChars: 60,
  findingsFromModel: 8,
  findingChars: 300,
});

// ─── JSON schemas (llama.cpp response_format) ───────────────────────────────
const str = (maxLength) => ({ type: 'string', maxLength });
const oneOf = (values) => ({ type: 'string', enum: [...values] });

export const TOPIC_SCHEMA = {
  type: 'object',
  properties: { topic: oneOf(TOPICS) },
  required: ['topic'],
  additionalProperties: false,
};

export const MENTION_SCHEMA = {
  type: 'object',
  properties: {
    mentions: {
      type: 'array',
      maxItems: LIMITS.mentionsPerPassage,
      items: {
        type: 'object',
        properties: { text: str(LIMITS.labelChars), type: oneOf(MENTION_TYPES) },
        required: ['text', 'type'],
        additionalProperties: false,
      },
    },
  },
  required: ['mentions'],
  additionalProperties: false,
};

export const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      maxItems: LIMITS.claimsPerPassage,
      items: {
        type: 'object',
        properties: {
          subject: str(LIMITS.labelChars),
          predicate: oneOf(PREDICATES),
          object: str(LIMITS.labelChars),
          qualifier: str(LIMITS.qualifierChars),
          modality: oneOf(MODALITIES),
          quote: str(LIMITS.quoteChars),
        },
        required: ['subject', 'predicate', 'object', 'modality', 'quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
};

// The single-prompt baseline: the same statement shape, for a whole transcript at once.
export const SINGLE_SCHEMA = {
  ...CLAIM_SCHEMA,
  properties: { claims: { ...CLAIM_SCHEMA.properties.claims, maxItems: LIMITS.claimsSingle } },
};

export const VERIFY_SCHEMA = {
  type: 'object',
  properties: { verdict: oneOf(SUPPORT) },
  required: ['verdict'],
  additionalProperties: false,
};

export const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      maxItems: LIMITS.findingsFromModel,
      items: {
        type: 'object',
        properties: {
          kind: oneOf(FINDING_KINDS),
          text: str(LIMITS.findingChars),
          passages: { type: 'array', maxItems: 6, items: { type: 'integer', minimum: 1 } },
        },
        required: ['kind', 'text', 'passages'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
};

// ─── Validators (pure; the model's JSON → typed values or errors) ───────────
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Labels lose surrounding whitespace and a trailing full stop or comma (Contoso Retail.).
const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '').trim().slice(0, max) : '');

/** @returns {{ ok: true, value } | { ok: false, errors: string[] }} */
export function checkTopic(reply) {
  if (!isObj(reply) || !TOPICS.includes(reply.topic)) return { ok: false, errors: [`topic must be one of ${TOPICS.join(', ')}`] };
  return { ok: true, value: reply.topic };
}

export function checkMentions(reply) {
  if (!isObj(reply) || !Array.isArray(reply.mentions)) return { ok: false, errors: ['expected {"mentions": [...]}'] };
  const errors = [];
  const value = [];
  reply.mentions.slice(0, LIMITS.mentionsPerPassage).forEach((m, i) => {
    const text = clean(m?.text, LIMITS.labelChars);
    if (!text) errors.push(`mentions[${i}].text is empty`);
    else if (!MENTION_TYPES.includes(m?.type)) errors.push(`mentions[${i}].type "${m?.type}" is not one of ${MENTION_TYPES.join(', ')}`);
    else value.push({ text, type: m.type });
  });
  return errors.length && value.length === 0 ? { ok: false, errors } : { ok: true, value, errors };
}

export function checkClaims(reply, max = LIMITS.claimsPerPassage) {
  if (!isObj(reply) || !Array.isArray(reply.claims)) return { ok: false, errors: ['expected {"claims": [...]}'] };
  const errors = [];
  const value = [];
  reply.claims.slice(0, max).forEach((c, i) => {
    const subject = clean(c?.subject, LIMITS.labelChars);
    const object = clean(c?.object, LIMITS.labelChars);
    const quote = typeof c?.quote === 'string' ? c.quote.trim().slice(0, LIMITS.quoteChars) : '';
    if (!subject || !object) errors.push(`claims[${i}] needs a subject and an object`);
    else if (!PREDICATES.includes(c?.predicate)) errors.push(`claims[${i}].predicate "${c?.predicate}" is not allowed`);
    else if (!MODALITIES.includes(c?.modality)) errors.push(`claims[${i}].modality "${c?.modality}" is not allowed`);
    else if (!quote) errors.push(`claims[${i}].quote is empty`);
    else value.push({ subject, predicate: c.predicate, object, qualifier: clean(c?.qualifier, LIMITS.qualifierChars) || null, modality: c.modality, quote });
  });
  return errors.length && value.length === 0 ? { ok: false, errors } : { ok: true, value, errors };
}

export function checkVerdict(reply) {
  if (!isObj(reply) || !SUPPORT.includes(reply.verdict)) return { ok: false, errors: [`verdict must be one of ${SUPPORT.join(', ')}`] };
  return { ok: true, value: reply.verdict };
}

/** passageCount bounds the passage numbers a finding may cite. */
export function checkFindings(reply, passageCount) {
  if (!isObj(reply) || !Array.isArray(reply.findings)) return { ok: false, errors: ['expected {"findings": [...]}'] };
  const errors = [];
  const value = [];
  reply.findings.slice(0, LIMITS.findingsFromModel).forEach((f, i) => {
    const text = clean(f?.text, LIMITS.findingChars);
    const passages = Array.isArray(f?.passages) ? [...new Set(f.passages.filter(n => Number.isInteger(n) && n >= 1 && n <= passageCount))] : [];
    if (!FINDING_KINDS.includes(f?.kind)) errors.push(`findings[${i}].kind must be issue or question`);
    else if (!text) errors.push(`findings[${i}].text is empty`);
    else value.push({ kind: f.kind, text, passages });
  });
  return errors.length && value.length === 0 ? { ok: false, errors } : { ok: true, value, errors };
}
