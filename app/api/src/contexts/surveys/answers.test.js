// What a respondent may fill in: shapes per answer type, the branches that
// open and close, rows, and what a submit needs that a draft does not.
import { describe, it, expect } from 'vitest';
import { checkAnswers, visibleQuestions, checkValue, isEmpty, MAX_PEOPLE } from './answers.js';

const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const ROW1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const ROW2 = 'bbbbbbbb-0000-4000-8000-000000000002';

const def = {
  schemaVersion: 1,
  languages: ['en'],
  title: 'T',
  sections: [{
    id: 's',
    questions: [
      { id: 'isOwner', text: 'Owner?', required: true, answer: { type: 'yesNo' } },
      { id: 'realOwner', text: 'Who?', required: true, showWhen: { question: 'isOwner', equals: 'no' }, answer: { type: 'person' } },
      { id: 'deputy', text: 'Deputy?', showWhen: { question: 'realOwner', equals: 'x' }, answer: { type: 'yesNo' } },
      { id: 'crit', text: 'Critical?', answer: { type: 'choice', options: [{ value: 'A' }, { value: 'B' }] } },
      { id: 'works', text: 'Works for you?', required: true, rows: { source: 'members' }, answer: { type: 'yesNo' } },
      { id: 'note', text: 'Note', answer: { type: 'text', maxLength: 10 } },
    ],
  }],
};
const rows = { works: new Set([ROW1, ROW2]) };

describe('visibleQuestions', () => {
  it('hides a branch until its question has the value, and a branch below a hidden one', () => {
    expect(visibleQuestions(def, {}).map(q => q.id)).toEqual(['isOwner', 'crit', 'works', 'note']);
    expect(visibleQuestions(def, { isOwner: 'no' }).map(q => q.id)).toEqual(['isOwner', 'realOwner', 'crit', 'works', 'note']);
    expect(visibleQuestions(def, { isOwner: 'yes', realOwner: 'x' }).map(q => q.id)).not.toContain('deputy');
  });
});

describe('checkValue', () => {
  const q = (type, extra = {}) => ({ id: 'x', answer: { type, ...extra } });
  it('takes each type\'s shape and refuses another', () => {
    expect(checkValue(q('yesNo'), 'no')).toBe('no');
    expect(checkValue(q('yesNo'), 'No')).toBeNull();
    expect(checkValue(q('choice', { options: [{ value: 'A' }, { value: 'B' }] }), 'B')).toBe('B');
    expect(checkValue(q('choice', { options: [{ value: 'A' }, { value: 'B' }] }), 'C')).toBeNull();
    expect(checkValue(q('multiChoice', { options: [{ value: 'A' }, { value: 'B' }] }), ['B', 'A', 'B'])).toEqual(['B', 'A']);
    expect(checkValue(q('multiChoice', { options: [{ value: 'A' }, { value: 'B' }] }), ['A', 'Z'])).toBeNull();
    expect(checkValue(q('multiChoice', { options: [{ value: 'A' }, { value: 'B' }] }), 'A')).toBeNull();
    expect(checkValue(q('text'), '  Runs payroll  ')).toBe('Runs payroll');
    expect(checkValue(q('text', { maxLength: 5 }), 'too long')).toBeNull();
    expect(checkValue(q('text'), 7)).toBeNull();
    expect(checkValue(q('date'), '2026-02-28')).toBe('2026-02-28');
    expect(checkValue(q('date'), '2026-02-30')).toBeNull();
    expect(checkValue(q('date'), 20260228)).toBeNull();
    expect(checkValue(q('nope'), 'x')).toBeNull();
  });

  it('a person is exactly one of principalId / identityId as a uuid; people drops repeats', () => {
    expect(checkValue(q('person'), { principalId: P1.toUpperCase(), displayName: ' Piet ' })).toEqual({ principalId: P1, displayName: 'Piet' });
    expect(checkValue(q('person'), { identityId: P2 })).toEqual({ identityId: P2, displayName: null });
    expect(checkValue(q('person'), { principalId: P1, identityId: P2 })).toBeNull();
    expect(checkValue(q('person'), { principalId: 'piet' })).toBeNull();
    expect(checkValue(q('person'), 'Piet')).toBeNull();
    expect(checkValue(q('people'), [{ principalId: P1 }, { principalId: P1 }, { identityId: P2 }]).map(p => p.principalId ?? p.identityId)).toEqual([P1, P2]);
    expect(checkValue(q('people'), [{ principalId: P1 }, { principalId: 'x' }])).toBeNull();
    expect(checkValue(q('people'), Array.from({ length: MAX_PEOPLE + 1 }, () => ({ principalId: P1 })))).toBeNull();
  });

  it('a confirm is ok, or not ok with the right value', () => {
    expect(checkValue(q('confirm', { shows: 'owner' }), { ok: true, value: 'ignored' })).toEqual({ ok: true });
    expect(checkValue(q('confirm', { shows: 'owner' }), { ok: false, value: ' Piet ' })).toEqual({ ok: false, value: 'Piet' });
    expect(checkValue(q('confirm', { shows: 'owner' }), { ok: false })).toBeNull();
    expect(checkValue(q('confirm', { shows: 'owner' }), { ok: 'yes' })).toBeNull();
  });

  it('isEmpty: null, undefined, empty text and empty list', () => {
    expect([null, undefined, '', []].every(isEmpty)).toBe(true);
    expect([0, 'no', {}, [1]].some(isEmpty)).toBe(false);
  });
});

describe('checkAnswers', () => {
  it('a draft keeps what is valid and names what is not, without asking for what is missing', () => {
    const r = checkAnswers(def, { isOwner: 'maybe', crit: 'A', note: 'x'.repeat(11) }, rows);
    expect(r.answers).toEqual({ crit: 'A' });
    expect(r.errors).toEqual([
      { question: 'isOwner', message: 'is not a valid answer to a yesNo question' },
      { question: 'note', message: 'is not a valid answer to a text question' },
    ]);
  });

  it('a submit needs every required question that is shown — a hidden one is not asked for', () => {
    const yes = checkAnswers(def, { isOwner: 'yes', works: { [ROW1]: 'yes', [ROW2]: 'no' } }, rows, { final: true });
    expect(yes.errors).toEqual([]);
    const no = checkAnswers(def, { isOwner: 'no', works: { [ROW1]: 'yes', [ROW2]: 'no' } }, rows, { final: true });
    expect(no.errors).toEqual([{ question: 'realOwner', message: 'needs an answer' }]);
  });

  it('drops the answer to a question its branch hides, even when it was filled in before', () => {
    const r = checkAnswers(def, { isOwner: 'yes', realOwner: { principalId: P1 } }, rows);
    expect(r.answers).toEqual({ isOwner: 'yes' });
  });

  it('keeps an answer in a branch a choice opened', () => {
    const r = checkAnswers({ ...def, sections: [{ id: 's', questions: [
      { id: 'a', text: 'A', answer: { type: 'choice', options: [{ value: 'x' }, { value: 'y' }] } },
      { id: 'b', text: 'B', showWhen: { question: 'a', equals: 'x' }, answer: { type: 'text' } },
    ] }] }, { a: 'x', b: 'shown' }, {});
    expect(r.answers).toEqual({ a: 'x', b: 'shown' });
  });

  it('per row: keeps only the rows asked about, checks each, and a required question needs them all', () => {
    const draft = checkAnswers(def, { isOwner: 'yes', works: { [ROW1]: 'yes', 'cccccccc-0000-4000-8000-000000000009': 'no', [ROW2]: 'perhaps' } }, rows);
    expect(draft.answers.works).toEqual({ [ROW1]: 'yes' });
    expect(draft.errors).toEqual([{ question: 'works', row: ROW2, message: 'is not a valid answer to a yesNo question' }]);
    const final = checkAnswers(def, { isOwner: 'yes', works: { [ROW1]: 'yes' } }, rows, { final: true });
    expect(final.errors).toEqual([{ question: 'works', rows: [ROW2], message: 'needs an answer for every row (1 open)' }]);
    expect(checkAnswers(def, { works: ['yes'] }, rows).errors).toEqual([{ question: 'works', message: 'answers per row are given as { rowId: answer }' }]);
  });

  it('treats a non-object as no answers at all', () => {
    expect(checkAnswers(def, 'yes', rows)).toEqual({ answers: {}, errors: [] });
    expect(checkAnswers(def, null, rows, { final: true }).errors.map(e => e.question)).toEqual(['isOwner', 'works']);
  });
});
