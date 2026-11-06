// Where a stored (folded) quote stands in the transcript as stored.
import { describe, it, expect } from 'vitest';
import { locateQuote, withQuoteOffsets, foldWithMap } from './quoteOffsets.js';
import { foldForQuote, verbatimQuote } from './claims.js';

const TRANSCRIPT = [
  'Interviewer: Who works on the Harbour Authority account?',
  'Piet de Vries:   Mostly me.  Jan   Smit left the account last month,',
  'and before that “Karel” did the planning.',
  'Interviewer: And Jan Smit?',
].join('\n');

const slice = (span) => TRANSCRIPT.slice(span.start, span.end);

describe('locateQuote', () => {
  it('finds a quote whose spaces the transcript has as runs, and returns the transcript\'s own span', () => {
    const span = locateQuote(TRANSCRIPT, 'Jan Smit left the account last month');
    expect(slice(span)).toBe('Jan   Smit left the account last month');
  });

  it('finds a quote that runs over a line break into the next turn', () => {
    const quote = verbatimQuote('last month, and before that "Karel" did', foldForQuote(TRANSCRIPT));
    const span = locateQuote(TRANSCRIPT, quote);
    expect(slice(span)).toBe('last month,\nand before that “Karel” did');
    expect(TRANSCRIPT.slice(span.start - 1, span.start)).toBe(' ');
  });

  it('takes the first occurrence of a quote said twice', () => {
    const span = locateQuote(TRANSCRIPT, 'Jan Smit');
    expect(span.start).toBe(TRANSCRIPT.indexOf('Jan   Smit'));
    expect(span.start).toBeLessThan(TRANSCRIPT.lastIndexOf('Jan Smit'));
  });

  it('falls back to a case-blind match, and finds nothing for words that were not said', () => {
    expect(slice(locateQuote(TRANSCRIPT, 'mostly me'))).toBe('Mostly me');
    expect(locateQuote(TRANSCRIPT, 'Piet runs everything')).toBeNull();
    expect(locateQuote('', 'x')).toBeNull();
    expect(locateQuote(TRANSCRIPT, '')).toBeNull();
  });

  it('the span of every quote the claim check accepts reads back as that quote', () => {
    const folded = foldForQuote(TRANSCRIPT);
    for (const said of ['Who works on the Harbour Authority account?', 'Mostly me. Jan Smit left', 'the planning. Interviewer: And']) {
      const quote = verbatimQuote(said, folded);
      expect(foldForQuote(slice(locateQuote(TRANSCRIPT, quote)))).toBe(quote);
    }
  });
});

describe('foldWithMap', () => {
  it('maps every folded character back to its index; leading space is dropped', () => {
    const { text, map } = foldWithMap('  a  b’');
    expect(text).toBe("a b'");
    expect(map).toEqual([2, 4, 5, 6]);
  });
});

describe('withQuoteOffsets', () => {
  it('sets the span where the quote is found and nulls elsewhere', () => {
    const out = withQuoteOffsets([{ quote: 'Mostly me.' }, { quote: null }, { quote: 'not there at all' }], TRANSCRIPT);
    expect(out.map(c => [c.quoteStart, c.quoteEnd])).toEqual([
      [TRANSCRIPT.indexOf('Mostly'), TRANSCRIPT.indexOf('Mostly') + 'Mostly me.'.length], [null, null], [null, null],
    ]);
  });
});
