// The pure part of answering a survey: language fallback, placeholders, the
// branches that open, progress over required questions and rows, and the
// answer edits the form makes.
import { describe, it, expect } from 'vitest';
import {
  textIn, fill, questionsOf, visibleQuestions, progress, setAnswer, answerAllRows, forSaving, columnLabel, wordsFor, pageOf, isOverdue,
} from './surveyText';

const def = {
  languages: ['nl', 'en'],
  sections: [
    { id: 'a', questions: [
      { id: 'isOwner', required: true, answer: { type: 'yesNo' } },
      { id: 'who', required: true, showWhen: { question: 'isOwner', equals: 'no' }, answer: { type: 'person' } },
      { id: 'deputy', showWhen: { question: 'who', equals: 'x' }, answer: { type: 'yesNo' } },
    ] },
    { id: 'b', questions: [
      { id: 'works', required: true, rows: { source: 'members' }, answer: { type: 'yesNo' } },
      { id: 'note', answer: { type: 'text' } },
    ] },
  ],
};
const rows = { works: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] };

describe('texts', () => {
  it('textIn falls back to the first language, then to any; fill leaves an unknown placeholder', () => {
    expect(textIn({ nl: 'Ja', en: 'Yes' }, 'en', def)).toBe('Yes');
    expect(textIn({ nl: 'Ja', en: 'Yes' }, 'de', def)).toBe('Ja');
    expect(textIn({ en: 'Yes' }, 'de', def)).toBe('Yes');
    expect(textIn(null, 'en', def)).toBe('');
    expect(fill('{context} / {respondent} / {row} / {x}', { context: 'Acme', row: 'Kim' })).toBe('Acme / {respondent} / Kim / {x}');
  });

  it('wordsFor speaks Dutch and English, English otherwise; columnLabel the same, the key when unknown', () => {
    expect(wordsFor('nl').submit).toBe('Versturen');
    expect(wordsFor('de').submit).toBe('Submit');
    expect(columnLabel('jobTitle', 'nl')).toBe('Functie');
    expect(columnLabel('jobTitle', 'fr')).toBe('Job title');
    expect(columnLabel('shoeSize', 'en')).toBe('shoeSize');
  });
});

describe('visibleQuestions', () => {
  it('opens a branch on its value and keeps a branch under a hidden one closed', () => {
    expect(questionsOf(def).map(q => `${q.sectionId}.${q.id}`)).toEqual(['a.isOwner', 'a.who', 'a.deputy', 'b.works', 'b.note']);
    expect(visibleQuestions(def, {}).map(q => q.id)).toEqual(['isOwner', 'works', 'note']);
    expect(visibleQuestions(def, { isOwner: 'no' }).map(q => q.id)).toEqual(['isOwner', 'who', 'works', 'note']);
    expect(visibleQuestions(def, { isOwner: 'yes', who: 'x' }).map(q => q.id)).not.toContain('deputy');
  });
});

describe('progress', () => {
  it('counts the required questions shown, each row of a per-row one, and names what is open', () => {
    expect(progress(def, {}, rows)).toEqual({ answered: 0, total: 4, missing: ['isOwner', 'works'] });
    const some = { isOwner: 'no', works: { r1: 'yes', r3: 'no' } };
    expect(progress(def, some, rows)).toEqual({ answered: 3, total: 5, missing: ['who', 'works'] });
    const all = { isOwner: 'yes', works: { r1: 'yes', r2: 'yes', r3: 'no' }, note: '' };
    expect(progress(def, all, rows)).toEqual({ answered: 4, total: 4, missing: [] });
  });
});

describe('editing answers', () => {
  it('setAnswer sets and clears, per question and per row, without touching the original', () => {
    const a = { isOwner: 'yes' };
    expect(setAnswer(a, 'note', 'hi')).toEqual({ isOwner: 'yes', note: 'hi' });
    expect(setAnswer(a, 'isOwner', '')).toEqual({});
    expect(setAnswer(a, 'works', 'no', 'r2')).toEqual({ isOwner: 'yes', works: { r2: 'no' } });
    expect(setAnswer({ works: { r2: 'no', r1: 'yes' } }, 'works', null, 'r2')).toEqual({ works: { r1: 'yes' } });
    expect(a).toEqual({ isOwner: 'yes' });
  });

  it('answerAllRows fills the open rows and keeps the answered ones unless told to overwrite', () => {
    const a = { works: { r2: 'no' } };
    expect(answerAllRows(a, 'works', ['r1', 'r2', 'r3'], 'yes')).toEqual({ works: { r1: 'yes', r2: 'no', r3: 'yes' } });
    expect(answerAllRows(a, 'works', ['r1', 'r2'], 'yes', { overwrite: true })).toEqual({ works: { r1: 'yes', r2: 'yes' } });
  });

  it('forSaving leaves out a "not correct" without the right value, at the top and per row — nothing else', () => {
    const answers = {
      c: { ok: false, value: ' ' },
      d: { ok: false, value: 'Piet' },
      e: { ok: true },
      p: { principalId: 'p1', displayName: 'Piet' },
      rows: { r1: { ok: false, value: '' }, r2: { ok: true }, r3: 'yes' },
      list: ['A'],
    };
    expect(forSaving(answers)).toEqual({
      d: { ok: false, value: 'Piet' }, e: { ok: true }, p: { principalId: 'p1', displayName: 'Piet' }, rows: { r2: { ok: true }, r3: 'yes' }, list: ['A'],
    });
  });
});

describe('pageOf and isOverdue', () => {
  it('pageOf clamps the page and always has at least one', () => {
    const list = Array.from({ length: 7 }, (_, i) => i);
    expect(pageOf(list, 1, 3)).toEqual({ rows: [3, 4, 5], page: 1, pages: 3 });
    expect(pageOf(list, 9, 3)).toEqual({ rows: [6], page: 2, pages: 3 });
    expect(pageOf(list, -1, 3).page).toBe(0);
    expect(pageOf([], 0, 3)).toEqual({ rows: [], page: 0, pages: 1 });
  });

  it('isOverdue: unanswered and past its date; today is not overdue; answered never is', () => {
    expect(isOverdue({ status: 'sent', dueAt: '2026-10-22' }, '2026-10-23')).toBe(true);
    expect(isOverdue({ status: 'sent', dueAt: '2026-10-23' }, '2026-10-23')).toBe(false);
    expect(isOverdue({ status: 'submitted', dueAt: '2026-01-01' }, '2026-10-23')).toBe(false);
    expect(isOverdue({ status: 'sent', dueAt: null }, '2026-10-23')).toBe(false);
  });
});
