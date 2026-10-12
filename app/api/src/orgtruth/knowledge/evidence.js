// Organisation knowledge extraction — stage 4a: deterministic evidence checks.
//
//   locateQuote(passage, quote)         → { startChar, endChar, quote, exact } | null
//   labelKey(label)                     → the comparable form of a name ("Omada-kernteam" → "omada kernteam")
//   mentionedIn(label, text)            → true when every word of the label occurs in the text
//   splitList(label)                    → ["Led", "Rob", "Mark", "Taake"] for "Led, Rob, Mark en Taake"
//
// The model is asked for a verbatim quote; a 4B model sometimes changes case,
// spacing or punctuation. locateQuote finds the quote in the passage exactly, or
// after folding those differences, and always answers with the SOURCE's own text
// and offsets — never the model's version. A quote that is not in the passage
// (a paraphrase, an invention) is not repaired: the statement is dropped.

export const MIN_QUOTE_CHARS = 8;

// Whitespace, quotes, brackets and punctuation: the differences a model makes when
// it "quotes" ("Wim Gregor en Eddie" for "Wim, Gregor en Eddie").
const FOLD = /[\s"'“”‘’„«»()[\],.;:!?…–—-]/u;

// The passage text folded to lowercase letters/digits/single spaces, with a map
// from every folded character back to its offset in the passage.
function folded(text) {
  let out = '';
  const map = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (FOLD.test(ch)) {
      if (out && !space) { out += ' '; map.push(i); space = true; }
      continue;
    }
    space = false;
    out += ch.toLowerCase();
    map.push(i);
  }
  if (out.endsWith(' ')) { out = out.slice(0, -1); map.pop(); }
  return { out, map };
}

function trimPunctuation(q) {
  return q.replace(/^[\s"'“”‘’„«»(.,;:…-]+|[\s"'“”‘’„«»).,;:…-]+$/gu, '');
}

/**
 * @param {{ startChar: number, text: string }} passage
 * @param {string} quote
 */
export function locateQuote(passage, quote) {
  const q = trimPunctuation(String(quote ?? ''));
  if (q.length < MIN_QUOTE_CHARS) return null;
  const at = passage.text.indexOf(q);
  if (at >= 0) return { startChar: passage.startChar + at, endChar: passage.startChar + at + q.length, quote: q, exact: true };
  const hay = folded(passage.text);
  const needle = folded(q).out;
  if (needle.length < MIN_QUOTE_CHARS) return null;
  const idx = hay.out.indexOf(needle);
  if (idx < 0) return null;
  const s = hay.map[idx];
  const e = hay.map[idx + needle.length - 1] + 1;
  return { startChar: passage.startChar + s, endChar: passage.startChar + e, quote: passage.text.slice(s, e), exact: false };
}

/** Lowercase, accents folded, hyphens/punctuation as spaces. */
export function labelKey(label) {
  return String(label ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const STOP = new Set(['de', 'het', 'een', 'the', 'a', 'an', 'van', 'of']);

/** Every significant word of the label occurs as a word (or word prefix ≥ 4) in the text. */
export function mentionedIn(label, text) {
  const words = labelKey(label).split(' ').filter(w => w && !STOP.has(w));
  if (words.length === 0) return false;
  const have = labelKey(text).split(' ');
  return words.every(w => have.some(h => h === w || (w.length >= 4 && h.startsWith(w)) || (h.length >= 4 && w.startsWith(h))));
}

/** "A, B en C" / "A and B" / "A & B" → its parts; anything else → [label]. */
export function splitList(label) {
  const parts = String(label ?? '').split(/\s*,\s*|\s+(?:en|and|&|plus)\s+/i).map(s => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [String(label ?? '').trim()];
}
