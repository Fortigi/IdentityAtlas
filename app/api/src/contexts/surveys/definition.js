// Survey templates — what a template's questions are, and the one check every
// definition passes before it is stored (docs/architecture/survey-templates.md).
//
//   checkDefinition(def)          → [] | [{ path, message }]
//   questionsOf(def)              → every question, in order, with its section id
//   textIn(text, lang, def)       → a text in one language (the template's first language when missing)
//   fill(text, values)            → the text with {context}, {respondent} and {row} filled in
//
// A definition:
//
//   { schemaVersion: 1, languages: ['en', 'nl'], title, intro?,
//     sections: [{ id, title?, questions: [{
//       id, text, help?, required?,
//       answer: { type, options?, shows?, maxLength? },
//       showWhen?: { question, equals },            // shown only when an earlier answer is this value
//       rows?: { source, columns? },               // asked once per member / resource / child context
//       becomes?: { kind, about?, attribute?, relation?, status? },
//     }] }] }
//
// A text is a string (one language) or { en: '…', nl: '…' } with at least the
// first language. `becomes` says what an answer means; without it an answer is
// only kept in the transcript. The rules that tie answer types, rows and
// `becomes` together are below (checkBecomes). Pure.

import { RELATIONS, MEMBERSHIP_STATUSES, MAX_ATTRIBUTE } from '../interviews/claims.js';

export const SCHEMA_VERSION = 1;
export const ANSWER_TYPES = Object.freeze(['yesNo', 'choice', 'multiChoice', 'text', 'person', 'people', 'date', 'confirm']);
export const YES_NO = Object.freeze(['yes', 'no']);
// What a per-row question is asked about, and the columns it may show next to each row.
export const ROW_SOURCES = Object.freeze({
  members: Object.freeze(['displayName', 'email', 'jobTitle', 'department', 'companyName', 'employeeId', 'principalType']),
  resources: Object.freeze(['displayName', 'resourceType', 'description', 'owner', 'certificationFrequency']),
  children: Object.freeze(['displayName', 'description', 'accountable']),
});
export const BECOMES_KINDS = Object.freeze(['description', 'property', 'alias', 'role', 'membership']);
// Who a claim is about: the context, the respondent, the person(s) answered, or the row.
export const ABOUT = Object.freeze(['context', 'respondent', 'answer', 'row']);

export const LIMITS = Object.freeze({ questions: 150, sections: 30, options: 30, text: 2000, id: 64 });
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const PERSON_ANSWERS = new Set(['person', 'people']);
const MAPPABLE = new Set(['yesNo', 'confirm', 'choice']);
// The kinds whose subject is the context itself.
const CONTEXT_KINDS = new Set(['description', 'property', 'alias']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const err = (path, message) => ({ path, message });

/** The values an answer of this question can take, for showWhen and for a relation/status map; null when open. */
export function answerValues(q) {
  const type = q?.answer?.type;
  if (type === 'yesNo' || type === 'confirm') return [...YES_NO];
  if (type === 'choice' || type === 'multiChoice') return (q.answer.options || []).map(o => o?.value);
  return null;
}

/** Every question of a definition, in order: [{ ...question, sectionId }]. */
export function questionsOf(def) {
  return (def?.sections || []).flatMap(s => (s?.questions || []).map(q => ({ ...q, sectionId: s.id })));
}

/** One language of a text: that language, else the template's first, else the first given. */
export function textIn(text, lang, def) {
  if (typeof text === 'string') return text;
  if (!isObj(text)) return '';
  const first = def?.languages?.[0];
  return text[lang] ?? text[first] ?? Object.values(text)[0] ?? '';
}

/** The text with {context}, {respondent} and {row} replaced; an unknown {name} is left as is. */
export function fill(text, values = {}) {
  return String(text ?? '').replace(/\{(context|respondent|row)\}/g, (m, k) => (values[k] == null ? m : String(values[k])));
}

function checkText(t, path, languages, { required = true } = {}) {
  if (t == null || t === '') return required ? [err(path, 'is required')] : [];
  if (typeof t === 'string') return t.length > LIMITS.text ? [err(path, `is longer than ${LIMITS.text} characters`)] : [];
  if (!isObj(t)) return [err(path, 'must be a text or { language: text }')];
  const out = [];
  if (!(typeof t[languages[0]] === 'string' && t[languages[0]].trim())) out.push(err(path, `needs the ${languages[0]} text`));
  for (const [lang, v] of Object.entries(t)) {
    if (!languages.includes(lang)) out.push(err(`${path}.${lang}`, `is not one of the template's languages (${languages.join(', ')})`));
    else if (typeof v !== 'string' || v.length > LIMITS.text) out.push(err(`${path}.${lang}`, `must be a text of at most ${LIMITS.text} characters`));
  }
  return out;
}

function checkLanguages(languages) {
  if (!Array.isArray(languages) || languages.length === 0) return [err('languages', 'name at least one language, e.g. ["en"]')];
  const bad = languages.filter(l => typeof l !== 'string' || !LANG_RE.test(l));
  if (bad.length) return [err('languages', `${bad.join(', ')} is not a language code like en or nl`)];
  if (new Set(languages).size !== languages.length) return [err('languages', 'names a language twice')];
  return [];
}

function checkOptions(answer, path, languages) {
  const opts = answer.options;
  if (!Array.isArray(opts) || opts.length < 2) return [err(`${path}.options`, 'a choice needs at least two options')];
  if (opts.length > LIMITS.options) return [err(`${path}.options`, `has more than ${LIMITS.options} options`)];
  const out = [];
  const seen = new Set();
  opts.forEach((o, i) => {
    const p = `${path}.options[${i}]`;
    if (!isObj(o) || typeof o.value !== 'string' || !o.value.trim()) { out.push(err(p, 'needs a value')); return; }
    if (seen.has(o.value)) out.push(err(p, `repeats the value "${o.value}"`));
    seen.add(o.value);
    out.push(...checkText(o.label ?? o.value, `${p}.label`, languages));
  });
  return out;
}

function checkAnswer(q, path, languages) {
  const a = q.answer;
  if (!isObj(a) || !ANSWER_TYPES.includes(a.type)) return [err(`${path}.answer.type`, `must be one of ${ANSWER_TYPES.join(', ')}`)];
  if (a.type === 'choice' || a.type === 'multiChoice') return checkOptions(a, `${path}.answer`, languages);
  if (a.type === 'confirm' && !(typeof a.shows === 'string' && a.shows.trim())) {
    return [err(`${path}.answer.shows`, 'a confirm question names what it shows to confirm (a column or an attribute)')];
  }
  if (a.maxLength != null && !(Number.isInteger(a.maxLength) && a.maxLength > 0 && a.maxLength <= LIMITS.text)) {
    return [err(`${path}.answer.maxLength`, `must be a whole number from 1 to ${LIMITS.text}`)];
  }
  return [];
}

function checkRows(q, path) {
  if (q.rows == null) return [];
  const r = q.rows;
  const columns = isObj(r) ? ROW_SOURCES[r.source] : null;
  if (!columns) return [err(`${path}.rows.source`, `must be one of ${Object.keys(ROW_SOURCES).join(', ')}`)];
  if (r.columns == null) return [];
  if (!Array.isArray(r.columns)) return [err(`${path}.rows.columns`, 'must be a list')];
  const bad = r.columns.filter(c => !columns.includes(c));
  return bad.length ? [err(`${path}.rows.columns`, `${bad.join(', ')} cannot be shown for ${r.source}; choose from ${columns.join(', ')}`)] : [];
}

// showWhen points at an EARLIER question asked about the context (not per row) and one of its values.
function checkShowWhen(q, path, earlier) {
  if (q.showWhen == null) return [];
  const w = q.showWhen;
  const target = isObj(w) ? earlier.get(w.question) : null;
  if (!target) return [err(`${path}.showWhen.question`, 'must name an earlier question')];
  if (target.rows) return [err(`${path}.showWhen.question`, 'cannot depend on a question asked per row')];
  const values = answerValues(target);
  if (!values) return [err(`${path}.showWhen.question`, `"${w.question}" has open answers; depend on a yes/no or choice question`)];
  return values.includes(w.equals) ? [] : [err(`${path}.showWhen.equals`, `must be one of ${values.join(', ')}`)];
}

// A relation or a status: one value, or a map from each answer value to one.
function checkMapped(value, allowed, q, path, name) {
  if (typeof value === 'string') return allowed.includes(value) ? [] : [err(`${path}.${name}`, `must be one of ${allowed.join(', ')}`)];
  if (!isObj(value)) return [err(`${path}.${name}`, `is required: one of ${allowed.join(', ')}, or a map from each answer to one`)];
  if (!MAPPABLE.has(q.answer?.type)) return [err(`${path}.${name}`, 'a map needs a yes/no, confirm or choice question')];
  const values = answerValues(q);
  const out = [];
  for (const [k, v] of Object.entries(value)) {
    if (!values.includes(k)) out.push(err(`${path}.${name}.${k}`, `is not an answer of this question (${values.join(', ')})`));
    else if (!allowed.includes(v)) out.push(err(`${path}.${name}.${k}`, `must be one of ${allowed.join(', ')}`));
  }
  return out;
}

// A description, an alias or a property: about the context — a property also about a resource row.
function contextKindAbout(b, about, q) {
  const resourceRow = b.kind === 'property' && about === 'row' && q.rows?.source === 'resources';
  if (about === 'context' || resourceRow) return null;
  const article = b.kind === 'alias' ? 'an' : 'a';
  return `${article} ${b.kind} is about the context${b.kind === 'property' ? ' (or a resource row)' : ''}`;
}

// A role or a membership: about a person the question can name.
const PERSON_ABOUT = {
  context: (b) => `a ${b.kind} is about a person: respondent, answer or row`,
  answer: (b, q) => (PERSON_ANSWERS.has(q.answer?.type) ? null : '"answer" needs a person or people question'),
  row: (b, q) => (q.rows?.source === 'members' ? null : '"row" needs a question asked per member'),
  respondent: (b, q) => (q.rows ? 'a question asked per row is about the row, not the respondent' : null),
};

// Who the claim can be about, given the question.
function checkAbout(b, q, path) {
  const about = b.about ?? (CONTEXT_KINDS.has(b.kind) ? 'context' : null);
  if (!ABOUT.includes(about)) return [err(`${path}.about`, `must be one of ${ABOUT.join(', ')}`)];
  const problem = CONTEXT_KINDS.has(b.kind) ? contextKindAbout(b, about, q) : PERSON_ABOUT[about](b, q);
  return problem ? [err(`${path}.about`, problem)] : [];
}

function checkBecomes(q, path) {
  const b = q.becomes;
  if (b == null) return [];
  const p = `${path}.becomes`;
  if (!isObj(b) || !BECOMES_KINDS.includes(b.kind)) return [err(`${p}.kind`, `must be one of ${BECOMES_KINDS.join(', ')}`)];
  const out = checkAbout(b, q, p);
  if (b.kind === 'property' && !(typeof b.attribute === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(b.attribute) && b.attribute.length <= MAX_ATTRIBUTE)) {
    out.push(err(`${p}.attribute`, 'a property names its attribute (letters, digits, _; e.g. criticality)'));
  }
  if (b.kind === 'role') out.push(...checkMapped(b.relation, RELATIONS, q, p, 'relation'));
  if (b.kind === 'membership') out.push(...checkMapped(b.status, MEMBERSHIP_STATUSES, q, p, 'status'));
  return out;
}

function checkQuestion(q, path, languages, earlier) {
  if (!isObj(q)) return [err(path, 'must be an object')];
  if (typeof q.id !== 'string' || !ID_RE.test(q.id) || q.id.length > LIMITS.id) {
    return [err(`${path}.id`, 'needs an id: a letter, then letters, digits, _ or -')];
  }
  if (earlier.has(q.id)) return [err(`${path}.id`, `"${q.id}" is used twice`)];
  return [
    ...checkText(q.text, `${path}.text`, languages),
    ...checkText(q.help, `${path}.help`, languages, { required: false }),
    ...checkAnswer(q, path, languages),
    ...checkRows(q, path),
    ...checkShowWhen(q, path, earlier),
    ...checkBecomes(q, path),
  ];
}

function checkSections(def, languages) {
  if (!Array.isArray(def.sections) || def.sections.length === 0) return [err('sections', 'a survey needs at least one section')];
  if (def.sections.length > LIMITS.sections) return [err('sections', `has more than ${LIMITS.sections} sections`)];
  const out = [];
  const earlier = new Map();
  const sectionIds = new Set();
  def.sections.forEach((s, si) => {
    const sp = `sections[${si}]`;
    if (!isObj(s) || !Array.isArray(s.questions) || s.questions.length === 0) { out.push(err(sp, 'a section needs at least one question')); return; }
    if (typeof s.id !== 'string' || !ID_RE.test(s.id) || sectionIds.has(s.id)) out.push(err(`${sp}.id`, 'needs its own id'));
    sectionIds.add(s.id);
    out.push(...checkText(s.title, `${sp}.title`, languages, { required: false }));
    s.questions.forEach((q, qi) => {
      out.push(...checkQuestion(q, `${sp}.questions[${qi}]`, languages, earlier));
      if (isObj(q) && typeof q.id === 'string' && !earlier.has(q.id)) earlier.set(q.id, q);
    });
  });
  if (earlier.size > LIMITS.questions) out.push(err('sections', `has more than ${LIMITS.questions} questions`));
  return out;
}

/** Every reason the definition cannot be stored; [] when it can. */
export function checkDefinition(def) {
  if (!isObj(def)) return [err('', 'a definition is a JSON object')];
  if (def.schemaVersion !== SCHEMA_VERSION) return [err('schemaVersion', `must be ${SCHEMA_VERSION}`)];
  const langErrors = checkLanguages(def.languages);
  if (langErrors.length) return langErrors;
  return [
    ...checkText(def.title, 'title', def.languages),
    ...checkText(def.intro, 'intro', def.languages, { required: false }),
    ...checkSections(def, def.languages),
  ];
}
