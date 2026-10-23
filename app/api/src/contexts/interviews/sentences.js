// Context interviews — check "they left" against the whole sentence it was said in.
//
//   sentenceAt(transcript, span)          → { start, end, text } — the sentence(s) around a span
//   sentenceOf(transcript, quote)         → that, for a quote (null when it is not found)
//   checkLeftClaim(claim, transcript)     → the claim, checked (a new object)
//   checkAgainstSentences(claims, transcript) → every claim, checked
//
// A small model quotes a fragment and decides from it: "Gerrit is sinds iets meer
// dan een jaar betrokken" came back as a membership 'former' — wrong, the
// sentence says he is in it now. And "Stijn en Noor hebben een periode
// meegewerkt" was right only because of "maar zijn inmiddels uitgestroomd", just
// after the quoted span. So a claim that says the person is gone — a membership
// former / left, a role / roleHistory whose words say left (leftSignal.js) — is
// read against the SENTENCE(S) its quote stands in (cut at . ! ? and line
// breaks; a turn is one line, "Speaker: words", and the speaker label is not
// part of the sentence):
//
//   the sentence says gone      (saysLeft, or past-only phrasing: "een periode",
//                                "destijds", "vroeger", "used to", "for a while")
//                               → kept as it is
//   else it says current        ("sinds", "is betrokken", "doet", "nu", "currently",
//                                "now", "works") → a membership becomes 'current';
//                               the value says so ("(corrected: the sentence says
//                               current; the model said former)"), which the review
//                               shows, and a role claim's left reading is dropped
//                               (leftSignal reads the same mark)
//   neither                     → kept, confidence at most UNSURE_CONFIDENCE (the
//                                review flags it)
//
// The quote stays the transcript's own words; where the sentence is at most
// MAX_WIDE_QUOTE characters the quote becomes the whole sentence, so the
// highlight shows the reason. Pure.

import { foldForQuote, MAX_VALUE } from './claims.js';
import { locateQuote } from './quoteOffsets.js';
import { GONE_STATUSES, CORRECTED_CURRENT, leftSignal, saysLeft } from './leftSignal.js';

export const MAX_WIDE_QUOTE = 300;
export const UNSURE_CONFIDENCE = 0.3;

// Whole words only ("nu" is not "nuttig", "works" not "workshop").
const PAST_RE = /(?<![\p{L}\p{N}])(?:een periode|een tijdje|destijds|vroeger|voorheen|beginjaren|toentertijd|used to|for a while|back then|previously|in the past|early years)(?![\p{L}\p{N}])/iu;
const CURRENT_RE = /(?<![\p{L}\p{N}])(?:sinds|is betrokken|zijn betrokken|nog steeds|nog altijd|momenteel|tegenwoordig|nu|doet|doen|werkt|werken|currently|now|still|since|is involved|are involved|is working|are working|works|does)(?![\p{L}\p{N}])/iu;

const END = /[.!?]/;
// "Anna Voorbeeld: " at the start of a turn.
const SPEAKER = /^[^\n:.!?]{1,60}:\s+/u;

/** The sentence(s) containing transcript[span.start, span.end). */
export function sentenceAt(transcript, { start, end }) {
  const t = String(transcript);
  let s = start;
  while (s > 0 && t[s - 1] !== '\n' && !(END.test(t[s - 2] ?? '') && /\s/.test(t[s - 1]))) s--;
  let e = end;
  while (e < t.length && t[e] !== '\n' && !(END.test(t[e - 1]) && /\s/.test(t[e]))) e++;
  if (s === 0 || t[s - 1] === '\n') {
    const label = SPEAKER.exec(t.slice(s, start));
    if (label) s += label[0].length;
  }
  while (s < start && /\s/.test(t[s])) s++;
  return { start: s, end: e, text: t.slice(s, e).trimEnd() };
}

export function sentenceOf(transcript, quote) {
  const span = locateQuote(transcript, quote);
  return span ? sentenceAt(transcript, span) : null;
}

/** Does the claim say the person is gone (and so need the check)? */
const saysGone = (c) => (c.claimKind === 'membership' ? GONE_STATUSES.includes(c.attribute) : leftSignal(c));

const noted = (value, note) => `${value} (${note})`.slice(0, MAX_VALUE);

export function checkLeftClaim(claim, transcript) {
  if (!claim?.quote || !saysGone(claim)) return claim;
  const sentence = sentenceOf(transcript, claim.quote);
  if (!sentence) return claim;
  const wide = foldForQuote(sentence.text);
  const quote = wide.length <= MAX_WIDE_QUOTE && wide.length > claim.quote.length ? wide : claim.quote;
  if (saysLeft(sentence.text) || PAST_RE.test(sentence.text)) return { ...claim, quote };
  if (CURRENT_RE.test(sentence.text)) {
    if (claim.claimKind === 'membership') {
      return { ...claim, quote, attribute: 'current', value: noted(claim.value, `${CORRECTED_CURRENT}; the model said ${claim.attribute}`) };
    }
    return { ...claim, quote, value: noted(claim.value, `${CORRECTED_CURRENT}, not left`) };
  }
  return { ...claim, quote, confidence: Math.min(claim.confidence ?? UNSURE_CONFIDENCE, UNSURE_CONFIDENCE) };
}

export function checkAgainstSentences(claims, transcript) {
  return claims.map(c => checkLeftClaim(c, transcript));
}
