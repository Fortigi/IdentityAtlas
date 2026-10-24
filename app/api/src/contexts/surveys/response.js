// Survey templates — a submitted survey as a source: its transcript and its claims.
//
//   buildResponse(def, answers, opts) → { transcript, claims }
//
// The transcript is the survey as answered, one line per answer:
//
//   Survey: Application intake: Payroll
//   Answered by: Jan de Vries, 2026-10-23
//
//   Ownership
//   Are you the owner of this application, Payroll?: No
//   Who is the owner, then?: Piet Jansen
//   Works for you? (Kim Los): Yes
//
// Every answer whose question says what it `becomes` is one claim (or one per
// person, for a people question), quoting its own line — so the transcript view
// highlights it and the review shows the question with the answer. The claim
// says which question it answers (surveyQuestionId). A survey states exactly what
// was answered: confidence 1, relevance high, the person matched by key. The
// roles it suggests follow the interview rules (interviews/roles.js deduceRoles).
// Pure: the caller (service.js) loads the rows and stores the result.
//
// opts: { lang, title, contextName, date, respondent: { principalId?, identityId?, name },
//         rows: { [questionId]: [{ id, kind: 'Principal'|'Identity'|'Resource'|'Context', displayName, columns }] },
//         contextValues: { [attribute]: current value } (what a confirm question about the context shows) }

import { textIn, fill, questionsOf } from './definition.js';
import { MAX_QUOTE, MAX_VALUE } from '../interviews/claims.js';
import { deduceRoles } from '../interviews/roles.js';

const WORDS = {
  en: { yes: 'Yes', no: 'No', correct: 'Yes, correct', notCorrect: 'No, it should be', survey: 'Survey', by: 'Answered by', empty: '(empty)' },
  nl: { yes: 'Ja', no: 'Nee', correct: 'Ja, klopt', notCorrect: 'Nee, het moet zijn', survey: 'Vragenlijst', by: 'Beantwoord door', empty: '(leeg)' },
};
const words = (lang) => WORDS[lang] ?? WORDS.en;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The answer as the respondent would read it, in one line. Pure. */
export function answerText(q, value, { lang, def, shown }) {
  const w = words(lang);
  const label = (v) => {
    const opt = (q.answer.options || []).find(o => o.value === v);
    return opt ? textIn(opt.label ?? opt.value, lang, def) : String(v);
  };
  switch (q.answer.type) {
    case 'yesNo': return w[value];
    case 'choice': return label(value);
    case 'multiChoice': return value.map(label).join(', ');
    case 'person': return value.displayName || value.principalId || value.identityId;
    case 'people': return value.map(p => p.displayName || p.principalId || p.identityId).join(', ');
    case 'confirm': return value.ok ? `${w.correct}${shown ? ` (${shown})` : ''}` : `${w.notCorrect}: ${value.value}`;
    default: return oneLine(value);
  }
}

// The answer as the claim's value: a stable value for a property (an option's
// value, yes/no), the right value for a confirm, the words for everything else.
function propertyValue(q, value, shown) {
  if (q.answer.type === 'confirm') return value.ok ? (shown || null) : value.value;
  if (q.answer.type === 'multiChoice') return value.join(', ');
  if (q.answer.type === 'person') return value.displayName;
  if (q.answer.type === 'people') return value.map(p => p.displayName).join(', ');
  return oneLine(value);
}

// The key a relation or status map is read with: yes/no, a confirm's yes/no, a choice's value.
function mapKey(q, value) {
  if (q.answer.type === 'confirm') return value.ok ? 'yes' : 'no';
  return typeof value === 'string' ? value : null;
}

function mapped(spec, q, value) {
  if (typeof spec === 'string') return spec;
  const key = mapKey(q, value);
  return key == null ? null : spec?.[key] ?? null;
}

const personSubject = (p, match) => ({
  subjectKind: 'Person',
  principalId: p.principalId ?? null,
  identityId: p.identityId ?? null,
  subjectName: p.displayName ?? p.name ?? null,
  subjectMatch: match,
});

function rowSubject(row) {
  if (row.kind === 'Resource') return { subjectKind: 'Resource', resourceId: row.id, subjectName: row.displayName };
  const id = row.kind === 'Identity' ? { identityId: row.id } : { principalId: row.id };
  return personSubject({ ...id, displayName: row.displayName }, 'key');
}

// Who the claims of one answer are about: [subject, …] (empty when none can be named).
function subjectsOf(b, q, value, { respondent, row }) {
  const about = b.about ?? 'context';
  if (about === 'context') return [{ subjectKind: 'Context' }];
  if (about === 'row') return row ? [rowSubject(row)] : [];
  if (about === 'respondent') return respondent.principalId || respondent.identityId ? [personSubject(respondent, 'interviewee')] : [];
  const people = q.answer.type === 'people' ? value : [value];
  return people.map(p => personSubject(p, 'key'));
}

// The claim's kind-specific fields, or null when this answer means nothing (an unmapped value, nothing to confirm).
// A role or membership claim says the line ("Works for you? (Kim Los): Yes"),
// or the words themselves when the answer is a text ("Projectmanager").
function claimFields(b, q, value, line, ctx) {
  if (b.kind === 'role' || b.kind === 'membership') {
    const attribute = mapped(b.kind === 'role' ? b.relation : b.status, q, value);
    return attribute ? { attribute, value: q.answer.type === 'text' ? oneLine(value) : line } : null;
  }
  const v = b.kind === 'property'
    ? propertyValue(q, value, ctx.shown)
    : oneLine(answerText(q, value, ctx));
  return v ? { attribute: b.kind === 'property' ? b.attribute : null, value: v } : null;
}

class Transcript {
  constructor() { this.text = ''; }

  /** Add a line; returns its span. */
  add(line) {
    if (this.text) this.text += '\n';
    const start = this.text.length;
    this.text += line;
    return { start, end: this.text.length };
  }
}

function claimsFor(q, value, line, span, ctx) {
  const b = q.becomes;
  if (!b) return [];
  const fields = claimFields(b, q, value, line, ctx);
  if (!fields) return [];
  const quoteEnd = Math.min(span.end, span.start + MAX_QUOTE);
  const quote = line.slice(0, quoteEnd - span.start);
  return subjectsOf(b, q, value, ctx).map(subject => ({
    claimKind: b.kind,
    subjectKind: 'Context',
    ...subject,
    attribute: fields.attribute,
    value: String(fields.value).slice(0, MAX_VALUE),
    quote,
    quoteStart: span.start,
    quoteEnd,
    confidence: 1,
    relevance: 'high',
    surveyQuestionId: q.id,
  }));
}

// [row, value] for every answer of a question: one per answered row, or the one answer.
function entriesOf(q, answers, rows) {
  if (!q.rows) return [[null, answers[q.id]]];
  return (rows[q.id] || []).filter(r => r.id in answers[q.id]).map(r => [r, answers[q.id][r.id]]);
}

// What a confirm question shows to be confirmed: the row's column, or the context's attribute.
function shownValue(q, row, contextValues) {
  if (q.answer.type !== 'confirm') return '';
  return oneLine(row ? row.columns?.[q.answer.shows] : contextValues[q.answer.shows]);
}

/** The transcript and the claims of a submitted survey. Pure. */
export function buildResponse(def, answers, opts) {
  const { lang, contextName, respondent, date, rows = {}, contextValues = {} } = opts;
  const w = words(lang);
  const fills = { context: contextName, respondent: respondent.name };
  const t = new Transcript();
  t.add(`${w.survey}: ${fill(textIn(def.title, lang, def), fills)}`);
  t.add(`${w.by}: ${respondent.name}, ${date}`);
  const claims = [];
  let section = null;
  for (const q of questionsOf(def).filter(x => x.id in answers)) {
    if (q.sectionId !== section) {
      section = q.sectionId;
      const title = def.sections.find(x => x.id === section)?.title;
      t.add(title ? `\n${fill(textIn(title, lang, def), fills)}` : '');
    }
    const asked = oneLine(fill(textIn(q.text, lang, def), fills));
    for (const [row, value] of entriesOf(q, answers, rows)) {
      const shown = shownValue(q, row, contextValues);
      const line = `${row ? `${asked} (${oneLine(row.displayName)})` : asked}: ${answerText(q, value, { lang, def, shown })}`;
      claims.push(...claimsFor(q, value, line, t.add(line), { respondent, row, shown, lang, def }));
    }
  }
  return { transcript: t.text, claims: deduceRoles(claims) };
}
