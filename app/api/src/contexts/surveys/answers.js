// Survey templates — checking what a respondent filled in.
//
//   visibleQuestions(def, answers)                → the questions shown, given the answers so far
//   checkAnswers(def, answers, rowIds, { final }) → { answers, errors }
//
// answers: { [questionId]: value } for a question about the context, and
// { [questionId]: { [rowId]: value } } for a question asked per row. A value by
// answer type:
//
//   yesNo        'yes' | 'no'
//   choice       one option value;  multiChoice: a list of option values
//   text         a text (at most answer.maxLength, else 2000 characters)
//   date         'YYYY-MM-DD'
//   person       { principalId | identityId, displayName };  people: a list of them (at most 20)
//   confirm      { ok: true } | { ok: false, value: 'the right value' }
//
// Empty (null, '', [], undefined) means not answered. An answer to a question
// that is not shown (its showWhen does not hold) is dropped; so is an answer to a
// row the question was not asked about. Saving a draft checks the shape of what
// is there; submitting (final) also needs every required question that is shown,
// and for a required per-row question every row. Pure.

import { questionsOf, answerValues, LIMITS } from './definition.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_PEOPLE = 20;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** The questions shown for these answers, in order. A question whose showWhen points at a hidden question is hidden. */
export function visibleQuestions(def, answers = {}) {
  const shown = new Set();
  return questionsOf(def).filter((q) => {
    const w = q.showWhen;
    const visible = !w || (shown.has(w.question) && answers[w.question] === w.equals);
    if (visible) shown.add(q.id);
    return visible;
  });
}

function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkPerson(v) {
  if (!isObj(v)) return null;
  const keys = ['principalId', 'identityId'].filter(k => v[k]);
  if (keys.length !== 1 || !UUID_RE.test(String(v[keys[0]]))) return null;
  const name = typeof v.displayName === 'string' ? v.displayName.trim().slice(0, 200) : '';
  return { [keys[0]]: String(v[keys[0]]).toLowerCase(), displayName: name || null };
}

function checkPeople(v) {
  if (!Array.isArray(v) || v.length > MAX_PEOPLE) return null;
  const people = v.map(checkPerson);
  if (people.some(p => !p)) return null;
  const seen = new Set();
  return people.filter((p) => {
    const key = p.principalId ?? p.identityId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function checkText(v, q) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.length <= (q.answer.maxLength ?? LIMITS.text) ? t : null;
}

function checkConfirm(v, q) {
  if (!isObj(v) || typeof v.ok !== 'boolean') return null;
  if (v.ok) return { ok: true };
  const value = checkText(v.value, q);
  return value ? { ok: false, value } : null;
}

function checkMulti(v, q) {
  const allowed = answerValues(q);
  if (!Array.isArray(v) || v.some(x => !allowed.includes(x))) return null;
  return [...new Set(v)];
}

const CHECKS = {
  yesNo: (v) => (v === 'yes' || v === 'no' ? v : null),
  choice: (v, q) => (answerValues(q).includes(v) ? v : null),
  multiChoice: checkMulti,
  text: checkText,
  date: (v) => (validDate(v) ? v : null),
  person: checkPerson,
  people: checkPeople,
  confirm: checkConfirm,
};

/** One answer of a question: the cleaned value, or null when it has the wrong shape. Pure. */
export function checkValue(q, v) {
  const check = CHECKS[q?.answer?.type];
  return check ? check(v, q) : null;
}

const typeError = (q) => `is not a valid answer to a ${q.answer.type} question`;

// A per-row question: { rowId: value } over the rows it was asked about.
function checkRowAnswers(q, given, rowIds, final, errors) {
  const out = {};
  if (given != null && !isObj(given)) {
    errors.push({ question: q.id, message: 'answers per row are given as { rowId: answer }' });
    return out;
  }
  for (const [rowId, v] of Object.entries(given ?? {})) {
    if (isEmpty(v) || !rowIds.has(rowId)) continue;
    const value = checkValue(q, v);
    if (value == null || isEmpty(value)) errors.push({ question: q.id, row: rowId, message: typeError(q) });
    else out[rowId] = value;
  }
  if (final && q.required) {
    const missing = [...rowIds].filter(id => !(id in out));
    if (missing.length) errors.push({ question: q.id, rows: missing, message: `needs an answer for every row (${missing.length} open)` });
  }
  return out;
}

function checkOne(q, given, final, errors) {
  if (isEmpty(given)) {
    if (final && q.required) errors.push({ question: q.id, message: 'needs an answer' });
    return undefined;
  }
  const value = checkValue(q, given);
  if (value == null || isEmpty(value)) {
    errors.push({ question: q.id, message: typeError(q) });
    return undefined;
  }
  return value;
}

/**
 * The answers as they may be stored, and every reason they may not.
 * @param rowIds  { [questionId]: Set of row ids } — the rows each per-row question is asked about
 */
export function checkAnswers(def, answers, rowIds = {}, { final = false } = {}) {
  const given = isObj(answers) ? answers : {};
  const errors = [];
  const out = {};
  // Visibility is read from the answers as checked so far: a malformed answer cannot open a branch.
  for (const q of visibleQuestions(def, given)) {
    if (q.showWhen && out[q.showWhen.question] !== q.showWhen.equals) continue;
    if (q.rows) {
      const rows = checkRowAnswers(q, given[q.id], rowIds[q.id] ?? new Set(), final, errors);
      if (Object.keys(rows).length) out[q.id] = rows;
      continue;
    }
    const value = checkOne(q, given[q.id], final, errors);
    if (value !== undefined) out[q.id] = value;
  }
  return { answers: out, errors };
}
