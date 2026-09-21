import { describe, it, expect } from 'vitest';
import {
  answerCard, welcomeCard, clarifyCard, notUnderstoodCard, unknownCallerCard,
  timeoutCard, errorCard, formatValue, MAX_ROWS, MAX_COLUMNS,
} from './card.js';
import { EN, NL } from './text.js';

/** Every TextBlock on the card, in order — what a reader actually sees. */
const lines = (card) => collect(card.content.body);

function collect(items) {
  return items.flatMap((item) => {
    if (item.type === 'TextBlock') return [item.text];
    if (item.type === 'ColumnSet') return item.columns.flatMap(c => collect(c.items));
    return [];
  });
}

const cols = (n) => Array.from({ length: n }, (_, i) => ({ key: `c${i}`, label: `Column ${i}` }));
const rows = (n, columnCount = 1) => Array.from({ length: n }, (_, r) =>
  Object.fromEntries(cols(columnCount).map(c => [c.key, `r${r}-${c.key}`])));

describe('answerCard', () => {
  const base = { explanation: 'Users whose manager is Wim', columns: cols(1), rows: rows(1) };

  it('opens with the interpretation, before any row', () => {
    // Order is the point: the interpretation is how a wrong name match gets
    // caught, and it only works above the rows.
    const seen = lines(answerCard(base));
    expect(seen[0]).toBe(EN.understoodAs);
    expect(seen[1]).toBe('Users whose manager is Wim');
    expect(seen.indexOf('Users whose manager is Wim')).toBeLessThan(seen.indexOf('r0-c0'));
  });

  it('shows every row up to the cap and does not say "showing"', () => {
    const card = answerCard({ ...base, rows: rows(MAX_ROWS) });
    const seen = lines(card);
    expect(seen).toContain(`r${MAX_ROWS - 1}-c0`);
    expect(seen).toContain(EN.records(MAX_ROWS));
    expect(seen.some(l => l.startsWith('Showing'))).toBe(false);
  });

  it('caps at MAX_ROWS and says what it left out, one row over the cap', () => {
    // MAX_ROWS + 1 is the only input that separates the cap from "no cap" and
    // from an off-by-one cap.
    const card = answerCard({ ...base, rows: rows(MAX_ROWS + 1) });
    const seen = lines(card);
    expect(seen).toContain(`r${MAX_ROWS - 1}-c0`);
    expect(seen).not.toContain(`r${MAX_ROWS}-c0`);
    expect(seen).toContain(EN.showing(MAX_ROWS, MAX_ROWS + 1));
  });

  it('shows every column up to the cap without mentioning hidden ones', () => {
    const card = answerCard({ explanation: 'x', columns: cols(MAX_COLUMNS), rows: rows(1, MAX_COLUMNS) });
    const seen = lines(card);
    expect(seen).toContain(`Column ${MAX_COLUMNS - 1}`);
    expect(seen.some(l => l.includes('more column'))).toBe(false);
  });

  it('caps columns one over the cap and counts the hidden ones', () => {
    const card = answerCard({ explanation: 'x', columns: cols(MAX_COLUMNS + 1), rows: rows(1, MAX_COLUMNS + 1) });
    const seen = lines(card);
    expect(seen).toContain(`Column ${MAX_COLUMNS - 1}`);
    expect(seen).not.toContain(`Column ${MAX_COLUMNS}`);
    expect(seen.join(' ')).toContain(EN.moreColumns(1));
  });

  it('never invents a column the definition did not ask for', () => {
    // The row carries an extra key. A renderer deriving columns from the row
    // would show it; one driven by `columns` cannot.
    const card = answerCard({
      explanation: 'x',
      columns: [{ key: 'displayName', label: 'Name' }],
      rows: [{ displayName: 'Jan', email: 'jan@example.com', _entity: { kind: 'user', id: 'u1' } }],
    });
    const seen = lines(card);
    expect(seen).toContain('Jan');
    expect(seen).not.toContain('jan@example.com');
    expect(seen.some(l => l.toLowerCase().includes('email'))).toBe(false);
  });

  it('restates the interpretation when nothing matched, instead of a bare "no results"', () => {
    const seen = lines(answerCard({ ...base, rows: [] }));
    expect(seen).toContain('Users whose manager is Wim');
    expect(seen).toContain(EN.noResults);
  });

  it('adds a link only when asked, and never on an empty answer with no link', () => {
    expect(answerCard({ ...base, rows: rows(11), link: 'https://ia.example/#bot-answer:1' }).content.actions)
      .toEqual([{ type: 'Action.OpenUrl', title: EN.openReport, url: 'https://ia.example/#bot-answer:1' }]);
    expect(answerCard({ ...base, rows: rows(11) }).content.actions).toBeUndefined();
    expect(answerCard({ ...base, rows: [] }).content.actions).toBeUndefined();
  });

  it('flags a truncated query separately from a truncated card', () => {
    // One row, so the card is NOT truncating; the QUERY is. The two notes are
    // different facts and a card that conflates them misreports the answer.
    const seen = lines(answerCard({ ...base, truncated: true })).join(' ');
    expect(seen).toContain(EN.rowLimit);
    expect(seen).toContain(EN.records(1));
  });

  it('carries the notes it is given, so a scope caveat reaches the reader', () => {
    const seen = lines(answerCard({ ...base, notes: [EN.scopeCaveat] }));
    expect(seen).toContain(EN.scopeCaveat);
    // Above the rows, with the rest of the interpretation.
    expect(seen.indexOf(EN.scopeCaveat)).toBeLessThan(seen.indexOf('r0-c0'));
  });

  it('writes its own chrome in Dutch when the question was Dutch', () => {
    const seen = lines(answerCard({ ...base, rows: [], language: 'nl' }));
    expect(seen).toContain(NL.understoodAs);
    expect(seen).toContain(NL.noResults);
    expect(seen).not.toContain(EN.noResults);
  });

  it('is a valid Adaptive Card attachment', () => {
    const card = answerCard(base);
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.content.type).toBe('AdaptiveCard');
    expect(card.content.version).toBe('1.5');
  });
});

describe('formatValue', () => {
  it.each([
    [null, '—'],
    [undefined, '—'],
    ['', '—'],
    [0, '0'],
    [false, 'false'],
    ['Jan', 'Jan'],
  ])('renders %j as %j', (input, expected) => {
    // 0 and false are the discriminating cases: a falsy check instead of an
    // explicit null/undefined/'' check turns a real zero into an em dash.
    expect(formatValue(input)).toBe(expected);
  });
});

describe('the other replies', () => {
  it('welcomes with exactly the three examples, in the caller\'s language', () => {
    expect(lines(welcomeCard('en'))).toEqual([EN.title, EN.welcome, ...EN.examples.map(e => `• ${e}`), EN.welcomeFooter]);
    expect(lines(welcomeCard('nl'))).toEqual([NL.title, NL.welcome, ...NL.examples.map(e => `• ${e}`), NL.welcomeFooter]);
  });

  it('offers the examples again when it did not understand, rather than an error', () => {
    const seen = lines(notUnderstoodCard('en'));
    expect(seen[0]).toBe(EN.notUnderstood);
    for (const example of EN.examples) expect(seen).toContain(`• ${example}`);
  });

  it('asks the clarifying question and lists the options under it', () => {
    const seen = lines(clarifyCard('Which Jan did you mean?', ['Jan de Vries', 'Jan Jansen']));
    expect(seen[0]).toBe('Which Jan did you mean?');
    expect(seen[1]).toBe('• Jan de Vries\n• Jan Jansen');
  });

  it('asks a clarifying question with no options without an empty bullet list', () => {
    expect(lines(clarifyCard('What do you mean by admin?', []))).toEqual(['What do you mean by admin?']);
  });

  it('tells an unknown caller what to do about it', () => {
    expect(lines(unknownCallerCard('nl'))).toEqual([NL.unknownCaller, NL.unknownCallerHint]);
  });

  it('says how long it waited, so the number is not a mystery', () => {
    expect(lines(timeoutCard(180, 'en'))).toEqual([EN.timeout, EN.timeoutHint(180)]);
    expect(lines(timeoutCard(180, 'en'))[1]).toContain('180');
  });

  it('never puts the underlying error in the chat', () => {
    expect(lines(errorCard('en'))).toEqual([EN.error, EN.errorHint]);
  });
});
