// "They left" read against the whole sentence: corrected to current, kept, or flagged unsure.
import { describe, it, expect } from 'vitest';
import { sentenceAt, sentenceOf, clauseFor, checkLeftClaim, checkAgainstSentences, MAX_WIDE_QUOTE, UNSURE_CONFIDENCE } from './sentences.js';
import { leftSignal, CORRECTED_CURRENT } from './leftSignal.js';

const NL = [
  'Interviewer: Wie werken er nog meer aan?',
  'Femke Voorbeeld: Gerrit is sinds iets meer dan een jaar betrokken en doet data mining. Stijn en Noor hebben beide ook een periode meegewerkt, maar zijn inmiddels uitgestroomd.',
  'Femke Voorbeeld: Daan heeft er ook aan gewerkt.',
].join('\n');

const EN = [
  'Interviewer: Who else?',
  'Femke Voorbeeld: Bram currently works on the reporting side. Lotte used to run the integrations! Joost helped with it.',
].join('\n');

const membership = (over) => ({ claimKind: 'membership', subjectName: 'Gerrit', attribute: 'former', value: 'betrokken', confidence: 0.8, ...over });

describe('sentenceAt / sentenceOf', () => {
  it('widens a span to its sentence: after ". " before it, up to the next end mark, without the speaker label', () => {
    const s = sentenceOf(NL, 'Stijn en Noor hebben beide ook een periode meegewerkt');
    expect(s.text).toBe('Stijn en Noor hebben beide ook een periode meegewerkt, maar zijn inmiddels uitgestroomd.');
    expect(NL.slice(s.start, s.end)).toBe(s.text);
    expect(sentenceOf(NL, 'Gerrit is sinds iets meer').text).toBe('Gerrit is sinds iets meer dan een jaar betrokken en doet data mining.');
  });

  it('stops at a line break and at ! and ?; a quote not in the transcript has no sentence', () => {
    expect(sentenceOf(EN, 'Lotte used to run').text).toBe('Lotte used to run the integrations!');
    expect(sentenceOf(NL, 'Wie werken er').text).toBe('Wie werken er nog meer aan?');
    expect(sentenceOf(NL, 'not in this transcript at all')).toBeNull();
  });

  it('a span at the very start of a transcript without a speaker keeps its first word', () => {
    expect(sentenceAt('Kees left. Then more', { start: 0, end: 4 }).text).toBe('Kees left.');
  });
});

describe('checkLeftClaim', () => {
  it('a "former" whose sentence says current (sinds, is betrokken, doet) becomes current, marked as corrected', () => {
    const c = checkLeftClaim(membership({ quote: 'Gerrit is sinds iets meer dan een jaar betrokken en doet data mining' }), NL);
    expect(c.attribute).toBe('current');
    expect(c.value).toBe(`betrokken (${CORRECTED_CURRENT}; the model said former)`);
    expect(c.quote).toBe('Gerrit is sinds iets meer dan een jaar betrokken en doet data mining.');
    expect(leftSignal(c)).toBe(false);
  });

  it('a "former" whose left signal stands after the quoted span stays former, the quote widened to show why', () => {
    const c = checkLeftClaim(membership({ subjectName: 'Stijn', quote: 'Stijn en Noor hebben beide ook een periode meegewerkt' }), NL);
    expect(c.attribute).toBe('former');
    expect(c.value).toBe('betrokken');
    expect(c.quote).toMatch(/maar zijn inmiddels uitgestroomd\.$/);
  });

  it('past-only phrasing (used to) keeps a "left" in English; current wording (currently works) corrects it', () => {
    expect(checkLeftClaim(membership({ subjectName: 'Lotte', attribute: 'left', quote: 'Lotte used to run the integrations' }), EN).attribute).toBe('left');
    expect(checkLeftClaim(membership({ subjectName: 'Bram', attribute: 'left', quote: 'Bram currently works' }), EN))
      .toMatchObject({ attribute: 'current', value: expect.stringContaining('the model said left') });
  });

  it('a sentence that says neither is kept with a low confidence', () => {
    const c = checkLeftClaim(membership({ subjectName: 'Joost', quote: 'Joost helped with it' }), EN);
    expect(c).toMatchObject({ attribute: 'former', confidence: UNSURE_CONFIDENCE, quote: 'Joost helped with it.' });
    expect(checkLeftClaim(membership({ subjectName: 'Joost', quote: 'Joost helped with it', confidence: 0.1 }), EN).confidence).toBe(0.1);
    expect(checkLeftClaim(membership({ subjectName: 'Daan', quote: 'Daan heeft er ook aan gewerkt', confidence: undefined }), NL).confidence).toBe(UNSURE_CONFIDENCE);
  });

  it('a role claim that says left but whose sentence says current loses the left reading', () => {
    const role = { claimKind: 'roleHistory', subjectName: 'Gerrit', attribute: 'member', value: 'left', quote: 'Gerrit is sinds iets meer', confidence: 0.7 };
    const c = checkLeftClaim(role, NL);
    expect(c.value).toBe(`left (${CORRECTED_CURRENT}, not left)`);
    expect(c.attribute).toBe('member');
    expect(leftSignal(c)).toBe(false);
  });

  it('leaves alone what says nobody left, a claim without a quote, a quote not found, and a sentence too long to quote whole', () => {
    const current = membership({ attribute: 'current', quote: 'Gerrit is sinds' });
    expect(checkLeftClaim(current, NL)).toBe(current);
    const noQuote = membership({ quote: null });
    expect(checkLeftClaim(noQuote, NL)).toBe(noQuote);
    const lost = membership({ quote: 'words that were never said' });
    expect(checkLeftClaim(lost, NL)).toBe(lost);
    const long = `Femke: Vera ${'heeft heel lang '.repeat(30)}meegedaan, nu niet meer.`;
    const c = checkLeftClaim(membership({ subjectName: 'Vera', quote: 'Vera heeft heel lang' }), long);
    expect(c.quote).toBe('Vera heeft heel lang');
    expect(long.length).toBeGreaterThan(MAX_WIDE_QUOTE);
  });

  it('checkAgainstSentences checks every claim', () => {
    const out = checkAgainstSentences([membership({ quote: 'Gerrit is sinds' }), { claimKind: 'description', value: 'x', quote: 'Wie werken er' }], NL);
    expect(out.map(c => c.attribute ?? null)).toEqual(['current', null]);
  });
});

// Two people in one sentence, split by ";": the leaving belongs to the second.
describe('clauseFor — one clause per person', () => {
  const TWO = 'Interviewer: Wie werkt eraan?\nAnna Voorbeeld: Gerrit is sinds iets meer dan een jaar betrokken en doet data mining; Stijn deed dat ook, maar is recent uitgestroomd.\n';
  const quote = 'Gerrit is sinds iets meer dan een jaar betrokken en doet data mining; Stijn deed dat ook, maar is recent uitgestroomd.';

  it('reads only the clause naming the person', () => {
    const s = 'Gerrit is sinds een jaar betrokken; Stijn deed dat ook, maar is uitgestroomd.';
    expect(clauseFor(s, 'Gerrit')).toBe('Gerrit is sinds een jaar betrokken');
    expect(clauseFor(s, 'Stijn de Boer')).toBe('Stijn deed dat ook, maar is uitgestroomd.');
    // No clause names them, or no ";": the whole sentence.
    expect(clauseFor(s, 'interviewee')).toBe(s);
    expect(clauseFor('Stijn en Noor hebben meegewerkt, maar zijn uitgestroomd.', 'Noor')).toBe('Stijn en Noor hebben meegewerkt, maar zijn uitgestroomd.');
    // Whole words: "Bas" is not in "Basten".
    expect(clauseFor('Van Basten doet het; Kees is weg.', 'Bas')).toBe('Van Basten doet het; Kees is weg.');
  });

  it('corrects the person who stays and keeps the one who left', () => {
    const gerrit = checkLeftClaim(membership({ subjectName: 'Gerrit', quote }), TWO);
    expect(gerrit.attribute).toBe('current');
    expect(gerrit.value).toContain(CORRECTED_CURRENT);
    const stijn = checkLeftClaim(membership({ subjectName: 'Stijn', quote }), TWO);
    expect(stijn.attribute).toBe('former');
    expect(stijn.value).toBe('betrokken');
  });
});
