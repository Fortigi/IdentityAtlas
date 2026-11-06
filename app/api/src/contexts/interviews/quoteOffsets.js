// Context interviews — where a claim's quote stands in its transcript.
//
//   locateQuote(transcript, quote) → { start, end } | null
//   withQuoteOffsets(claims, transcript) → the claims with quoteStart / quoteEnd
//
// A claim's quote is stored as the transcript's own words in folded form
// (claims.js foldForQuote: whitespace runs as one space, typographic quotes
// straight). The transcript view highlights it, so it needs the span in the
// transcript AS STORED: start (inclusive) and end (exclusive) as string indices.
// The transcript is folded the same way with a map back to its own indices; the
// first occurrence wins. A quote not found (an analyst's claim without one, a
// transcript that would need Unicode normalisation to match) has no offsets and
// is simply not highlighted. Pure.

const SINGLE = /[‘’‚‛′]/;
const DOUBLE = /[“”„‟″]/;

// The folded transcript and, per folded character, its index in the original.
export function foldWithMap(text) {
  let out = '';
  const map = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      space = out.length > 0;
      continue;
    }
    if (space) { out += ' '; map.push(i - 1); space = false; }
    out += SINGLE.test(ch) ? "'" : DOUBLE.test(ch) ? '"' : ch;
    map.push(i);
  }
  return { text: out, map };
}

let cached = { text: null, folded: null };
const foldedOf = (text) => {
  if (cached.text !== text) cached = { text, folded: foldWithMap(text) };
  return cached.folded;
};

export function locateQuote(transcript, quote) {
  const q = String(quote ?? '');
  if (!transcript || !q) return null;
  const folded = foldedOf(String(transcript));
  let at = folded.text.indexOf(q);
  if (at < 0) {
    const lower = folded.text.toLowerCase();
    // Only when lowercasing keeps every index where it was.
    if (lower.length === folded.text.length) at = lower.indexOf(q.toLowerCase());
  }
  if (at < 0) return null;
  return { start: folded.map[at], end: folded.map[at + q.length - 1] + 1 };
}

export function withQuoteOffsets(claims, transcript) {
  return claims.map(c => {
    const span = c.quote ? locateQuote(transcript, c.quote) : null;
    return { ...c, quoteStart: span?.start ?? null, quoteEnd: span?.end ?? null };
  });
}
