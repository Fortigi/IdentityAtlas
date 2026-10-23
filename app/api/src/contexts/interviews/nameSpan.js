// Context interviews — the full name a quote gives for a name the model cut short.
//
//   nameSpansIn(subjectName, quote) → ['Piet de Vries', …]   (longest first)
//
// A small model writes subject "Vries" (or "de Vries") for the quote "Piet de
// Vries does most of the day-to-day". The quote is verbatim, so the full name is
// in it: a run of capitalised words — 2 to 4 of them, with the particles of
// MIDDLE_PARTICLES between them (van, de, der, …) — that CONTAINS the subject's
// words in order and is longer than the subject. Every such span is returned,
// longest first ("So Piet de Vries" before "Piet de Vries"), so the caller can try
// each against the directory; a span that matches nobody costs nothing.
// Punctuation (a comma, a full stop) ends a run. Pure.

export const PARTICLES = new Set(['van', 'de', 'der', 'den', 'von', 'el', 'al', 'la', 'le', 'du', 'da', 'di', 'ten', 'ter', 'het', "'t"]);
export const MIN_NAME_WORDS = 2;
export const MAX_NAME_WORDS = 4;

const WORD = /^[\p{L}][\p{L}'’-]*$/u;
const isCapital = (w) => /^\p{Lu}/u.test(w);
const isParticle = (w) => PARTICLES.has(w.toLowerCase().replace('’', "'"));
const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean);
// A possessive is the name it belongs to: "Hilderink's" is Hilderink.
const bare = (w) => w.replace(/['’]s$/u, '');

// The runs of name-like words: punctuation and digits break a run.
function runsOf(quote) {
  return String(quote ?? '').split(/[^\p{L}'’\s-]+/u).map(seg => words(seg).filter(w => WORD.test(w)).map(bare)).filter(r => r.length);
}

const indexOfSeq = (hay, needle) => {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((n, k) => hay[i + k] === n)) return i;
  }
  return -1;
};

// Is run[i..j] a name: capitalised at both ends, particles or capitals between,
// MIN..MAX capitalised words?
function isNameSpan(run, i, j) {
  if (!isCapital(run[i]) || !isCapital(run[j])) return false;
  let capitals = 0;
  for (let k = i; k <= j; k++) {
    if (isCapital(run[k])) capitals++;
    else if (!isParticle(run[k])) return false;
  }
  return capitals >= MIN_NAME_WORDS && capitals <= MAX_NAME_WORDS;
}

function spansOfRun(run, subject) {
  const lower = run.map(w => w.toLowerCase());
  const out = [];
  for (let i = 0; i < run.length; i++) {
    for (let j = run.length - 1; j - i + 1 > subject.length; j--) {
      const at = indexOfSeq(lower.slice(i, j + 1), subject);
      if (at >= 0 && isNameSpan(run, i, j)) out.push(run.slice(i, j + 1).join(' '));
    }
  }
  return out;
}

/** The names in `quote` that contain `subjectName` and are longer, longest first. */
export function nameSpansIn(subjectName, quote) {
  const subject = words(String(subjectName ?? '').replace(/[^\p{L}'’\s-]+/gu, ' ')).map(w => bare(w).toLowerCase());
  if (subject.length === 0) return [];
  const spans = new Set(runsOf(quote).flatMap(run => spansOfRun(run, subject)));
  return [...spans].sort((a, b) => words(b).length - words(a).length);
}
