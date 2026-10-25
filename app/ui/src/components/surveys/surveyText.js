// Survey form helpers — the pure part of answering a survey.
//
// The form opens and closes questions as the respondent answers, so the
// visibility rule runs here too; the API applies the same rule again on save
// and submit (app/api/src/contexts/surveys/answers.js) and is the one that
// decides. The definition format: docs/architecture/survey-templates.md.

/** One language of a text: that language, else the template's first, else any. */
export function textIn(text, lang, def) {
  if (typeof text === 'string') return text;
  if (!text || typeof text !== 'object') return '';
  return text[lang] ?? text[def?.languages?.[0]] ?? Object.values(text)[0] ?? '';
}

/** The text with {context}, {respondent} and {row} filled in. */
export function fill(text, values = {}) {
  return String(text ?? '').replace(/\{(context|respondent|row)\}/g, (m, k) => (values[k] == null ? m : String(values[k])));
}

/** Every question, in order, with its section id. */
export function questionsOf(def) {
  return (def?.sections || []).flatMap(s => (s?.questions || []).map(q => ({ ...q, sectionId: s.id })));
}

/** The questions shown for these answers. A question whose showWhen points at a hidden one is hidden. */
export function visibleQuestions(def, answers = {}) {
  const shown = new Set();
  return questionsOf(def).filter((q) => {
    const w = q.showWhen;
    const visible = !w || (shown.has(w.question) && answers[w.question] === w.equals);
    if (visible) shown.add(q.id);
    return visible;
  });
}

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * How far the respondent is: { answered, total, missing } over the required
 * questions that are shown — a per-row question counts each row. `missing`
 * names the required questions still open.
 */
export function progress(def, answers = {}, rows = {}) {
  let answered = 0;
  let total = 0;
  const missing = [];
  for (const q of visibleQuestions(def, answers).filter(x => x.required)) {
    const ids = q.rows ? (rows[q.id] || []).map(r => r.id) : [null];
    const done = ids.filter(id => !isEmpty(id == null ? answers[q.id] : answers[q.id]?.[id])).length;
    answered += done;
    total += ids.length;
    if (done < ids.length) missing.push(q.id);
  }
  return { answered, total, missing };
}

/** The answers with one answer set (or cleared, for an empty value); per row when rowId is given. */
export function setAnswer(answers, questionId, value, rowId = null) {
  if (rowId == null) {
    const next = { ...answers };
    if (isEmpty(value)) delete next[questionId];
    else next[questionId] = value;
    return next;
  }
  const rowsOf = { ...(answers[questionId] || {}) };
  if (isEmpty(value)) delete rowsOf[rowId];
  else rowsOf[rowId] = value;
  return { ...answers, [questionId]: rowsOf };
}

/** Every row of a per-row question answered with `value`, keeping answers already given unless `overwrite`. */
export function answerAllRows(answers, questionId, rowIds, value, { overwrite = false } = {}) {
  const current = answers[questionId] || {};
  const next = { ...current };
  for (const id of rowIds) if (overwrite || isEmpty(current[id])) next[id] = value;
  return { ...answers, [questionId]: next };
}

// An answer still being typed: "not correct" before the right value is given.
const unfinished = (v) => v && typeof v === 'object' && v.ok === false && !String(v.value ?? '').trim();

/** The answers as a draft can be saved: without a "not correct" whose right value is still empty. */
export function forSaving(answers = {}) {
  const out = {};
  for (const [q, v] of Object.entries(answers)) {
    if (unfinished(v)) continue;
    const perRow = v && typeof v === 'object' && !Array.isArray(v) && !('ok' in v) && !('principalId' in v) && !('identityId' in v);
    out[q] = perRow ? Object.fromEntries(Object.entries(v).filter(([, x]) => !unfinished(x))) : v;
  }
  return out;
}

// The columns a per-row question can show, by name.
const COLUMN_LABELS = {
  en: { displayName: 'Name', email: 'E-mail', jobTitle: 'Job title', department: 'Department', companyName: 'Company', employeeId: 'Employee ID', principalType: 'Type', resourceType: 'Type', description: 'Description', owner: 'Owner', certificationFrequency: 'Certification', accountable: 'Accountable' },
  nl: { displayName: 'Naam', email: 'E-mail', jobTitle: 'Functie', department: 'Afdeling', companyName: 'Bedrijf', employeeId: 'Personeelsnummer', principalType: 'Soort', resourceType: 'Soort', description: 'Omschrijving', owner: 'Eigenaar', certificationFrequency: 'Hercertificering', accountable: 'Eigenaar' },
};
export const columnLabel = (key, lang) => (COLUMN_LABELS[lang] ?? COLUMN_LABELS.en)[key] ?? key;

/** The words the form uses around the questions, in the survey's language (English when it has none). */
const WORDS = {
  en: { yes: 'Yes', no: 'No', correct: 'Correct', notCorrect: 'Not correct', rightValue: 'The right value', save: 'Save draft', submit: 'Submit', allYes: 'All yes', allCorrect: 'All correct', saved: 'Draft saved', of: 'of', answered: 'answered', due: 'Due', choose: 'Choose…', remove: 'Remove', addPerson: 'Add a person', nobody: 'Nobody yet', previous: 'Previous', next: 'Next' },
  nl: { yes: 'Ja', no: 'Nee', correct: 'Klopt', notCorrect: 'Klopt niet', rightValue: 'De juiste waarde', save: 'Concept opslaan', submit: 'Versturen', allYes: 'Allemaal ja', allCorrect: 'Alles klopt', saved: 'Concept opgeslagen', of: 'van', answered: 'beantwoord', due: 'Uiterlijk', choose: 'Kies…', remove: 'Verwijderen', addPerson: 'Persoon toevoegen', nobody: 'Nog niemand', previous: 'Vorige', next: 'Volgende' },
};
export const wordsFor = (lang) => WORDS[lang] ?? WORDS.en;

/** Whether an unanswered survey is past its due date (today counts as not yet). */
export function isOverdue(s, today = new Date().toISOString().slice(0, 10)) {
  return s.status === 'sent' && !!s.dueAt && s.dueAt < today;
}

/** One page of rows: { rows, page, pages }. Page numbers start at 0 and are clamped. */
export function pageOf(rows, page, size) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { rows: rows.slice(p * size, (p + 1) * size), page: p, pages };
}
