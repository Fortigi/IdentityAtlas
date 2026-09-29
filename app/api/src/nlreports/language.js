// Natural-language reports — which language a question was asked in.
//
// The pipeline records the language of every question it answers, because
// language parity is something to MEASURE rather than assume: a report that is
// right in English and wrong in Dutch is a common failure of a small model, and
// counting it needs the language on the row. It is also what a chat surface
// answers in.
//
// Detection is a word-list, not a language model. It only has to separate Dutch
// from English on one short sentence, and it must never be the slow part of an
// answer that is already measured in tens of seconds.

export const LANGUAGES = Object.freeze(['en', 'nl']);

// Dutch function words that essentially never appear in an English question
// about access. Deliberately excludes words the two languages share ("in",
// "is", "of", "me", "at"), which are exactly the ones that would make an
// English question look Dutch.
const DUTCH_MARKERS = [
  'wie', 'welke', 'wat', 'waar', 'hoeveel', 'mijn', 'mijne', 'zijn', 'heeft', 'hebben',
  'toegang', 'groep', 'groepen', 'gebruiker', 'gebruikers', 'lid', 'leden', 'rechten',
  'eigenaar', 'eigenaren', 'rol', 'rollen', 'niet', 'geen', 'alle', 'met', 'voor',
  'van', 'het', 'een', 'die', 'dat', 'ik', 'onze', 'zonder', 'medewerker', 'medewerkers',
  'hulp',
];

const WORD_RE = /[\p{L}]+/gu;

/**
 * Which language a question is in.
 *
 * Returns 'nl' when Dutch markers outweigh the noise, 'en' otherwise — English
 * is the default because an English reply to a Dutch question is understood,
 * while the reverse is not reliably true in this customer base.
 *
 * @param {string} question
 * @returns {'en'|'nl'}
 */
export function detectLanguage(question) {
  const words = String(question ?? '').toLowerCase().match(WORD_RE) ?? [];
  if (words.length === 0) return 'en';
  const markers = new Set(DUTCH_MARKERS);
  const hits = words.filter(w => markers.has(w)).length;
  // Two markers, or one in a very short question ("mijn groepen?"). A single
  // marker in a long English sentence is a loan word, not a language.
  return hits >= 2 || (hits === 1 && words.length <= 3) ? 'nl' : 'en';
}
