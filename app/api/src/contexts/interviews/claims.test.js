// The one check every claim passes — a model's and an analyst's.
import { describe, it, expect } from 'vitest';
import { checkClaim, foldForQuote, verbatimQuote, periodDate, MIN_QUOTE, MAX_ATTRIBUTE } from './claims.js';

const TRANSCRIPT = `Interviewer: Who owns the planning tool?
Anna Voorbeeld: Yes, I’m the owner of this app,   but it's mostly Piet who does the day-to-day.
Anna Voorbeeld: We have been a customer since 2019.`;
const folded = foldForQuote(TRANSCRIPT);

const role = (over = {}) => ({ kind: 'role', subject: 'Piet', relation: 'dayToDay', value: 'does the day-to-day', quote: "it's mostly Piet who does the day-to-day", ...over });

describe('verbatimQuote', () => {
  it('finds a quote across folded whitespace and a typographic apostrophe, without the marks a model adds', () => {
    expect(verbatimQuote('"Yes, I\'m the owner of this app, but it\'s mostly Piet"', folded))
      .toBe("Yes, I'm the owner of this app, but it's mostly Piet");
  });

  it('refuses a paraphrase, a quote changed by one word, and one too short to prove anything', () => {
    expect(verbatimQuote('I am the owner of this app', folded)).toBeNull();
    expect(verbatimQuote('We have been a client since 2019', folded)).toBeNull();
    expect(verbatimQuote('Yes, I’m', folded)).toBe("Yes, I'm"); // exactly MIN_QUOTE characters
    expect("Yes, I'm".length).toBe(MIN_QUOTE);
    expect(verbatimQuote('Yes, I', folded)).toBeNull();
  });
});

describe('periodDate', () => {
  it('takes the first day of a start period and the last day of an end period', () => {
    expect(periodDate('2019')).toBe('2019-01-01');
    expect(periodDate('2019', true)).toBe('2019-12-31');
    expect(periodDate('2024-02', true)).toBe('2024-02-29');
    expect(periodDate('2023-02', true)).toBe('2023-02-28');
    expect(periodDate('2019-3')).toBe('2019-03-01');
    expect(periodDate('2019-03-14', true)).toBe('2019-03-14');
  });

  it('turns vague or impossible periods into null', () => {
    for (const v of ['early on', '2019-13', '2019-02-30', '19', '', null, undefined, '2019-00']) expect(periodDate(v)).toBeNull();
  });
});

describe('checkClaim', () => {
  it('a role claim keeps its person, relation, period and folded quote', () => {
    expect(checkClaim(role({ periodFrom: '2021', periodText: ' now ', confidence: 0.83 }), folded)).toEqual({
      claim: {
        claimKind: 'role', subjectKind: 'Person', subjectName: 'Piet', attribute: 'dayToDay', value: 'does the day-to-day',
        periodFrom: '2021-01-01', periodTo: null, periodText: 'now', quote: "it's mostly Piet who does the day-to-day", confidence: 0.83,
      },
    });
  });

  it('drops a claim whose quote is not in the transcript, saying why', () => {
    expect(checkClaim(role({ quote: 'Piet runs the whole thing' }), folded)).toEqual({ error: expect.stringMatching(/verbatim/), reason: 'quote' });
  });

  it('a model claim without a quote is dropped; an analyst may add one without', () => {
    expect(checkClaim(role({ quote: undefined }), folded).reason).toBe('quote');
    expect(checkClaim(role({ quote: undefined }), folded, { quoteRequired: false }).claim.quote).toBeNull();
  });

  it('a description and a property are about the context, whatever subject the reply gives', () => {
    const d = checkClaim({ kind: 'description', subject: 'Anna', value: 'A planning tool', quote: 'Who owns the planning tool?' }, folded).claim;
    expect(d).toMatchObject({ subjectKind: 'Context', subjectName: null, attribute: null });
    const p = checkClaim({ kind: 'property', subject: 'Anna', attribute: ' customerSince ', value: '2019', quote: 'a customer since 2019' }, folded).claim;
    expect(p).toMatchObject({ subjectKind: 'Context', subjectName: null, attribute: 'customerSince', value: '2019' });
  });

  it('a property needs a short attribute name without control characters', () => {
    const base = { kind: 'property', value: '2019', quote: 'a customer since 2019' };
    expect(checkClaim({ ...base }, folded).reason).toBe('invalid');
    expect(checkClaim({ ...base, attribute: 'a'.repeat(MAX_ATTRIBUTE) }, folded).claim.attribute).toHaveLength(MAX_ATTRIBUTE);
    expect(checkClaim({ ...base, attribute: 'a'.repeat(MAX_ATTRIBUTE + 1) }, folded).reason).toBe('invalid');
    expect(checkClaim({ ...base, attribute: 'since\u0007' }, folded).reason).toBe('invalid');
  });

  it('a role claim needs its person; an unknown relation reads as other', () => {
    expect(checkClaim(role({ subject: '  ' }), folded).error).toMatch(/person/);
    expect(checkClaim(role({ relation: 'boss' }), folded).claim.attribute).toBe('other');
    expect(checkClaim({ ...role(), kind: 'roleHistory', relation: undefined }, folded).claim.attribute).toBe('other');
  });

  it('refuses an unknown kind, a missing value and a non-object', () => {
    expect(checkClaim(role({ kind: 'fact' }), folded).error).toMatch(/kind must be one of description, property, role, roleHistory/);
    expect(checkClaim(role({ value: '   ' }), folded).error).toBe('a claim needs a value');
    expect(checkClaim(null, folded).reason).toBe('invalid');
  });

  it('clamps confidence to 0..1 and defaults a missing or non-numeric one to 0.5', () => {
    expect(checkClaim(role({ confidence: 1.7 }), folded).claim.confidence).toBe(1);
    expect(checkClaim(role({ confidence: -0.2 }), folded).claim.confidence).toBe(0);
    expect(checkClaim(role({ confidence: '0.9' }), folded).claim.confidence).toBe(0.5);
    expect(checkClaim(role({ confidence: 0.456 }), folded).claim.confidence).toBe(0.46);
  });
});
