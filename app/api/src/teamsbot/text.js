// Teams bot (POC) — the bot's own wording, in the two languages it answers in.
//
// Only the CHROME is translated here: the sentences the bot itself writes. The
// report's interpretation line comes from explainSpec() and is English whatever
// the question was, and a clarifying question comes back in whatever language
// the model wrote it. That asymmetry is deliberate for the POC — the spec calls
// language parity a thing to MEASURE, not a thing to guarantee — and it is why
// every answer logs the language it detected, so the mismatches can be counted
// instead of argued about.
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
  // 'hulp' is both unambiguously Dutch and one of the words that summons the
  // welcome card, so without it a Dutch speaker typing 'hulp' is welcomed in English.
  'hulp',
];

const WORD_RE = /[\p{L}]+/gu;

/**
 * Which language to answer in.
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

const EN = Object.freeze({
  understoodAs: 'Understood as',
  noResults: 'No records match that.',
  records: (n) => `${n} ${n === 1 ? 'record' : 'records'}.`,
  showing: (shown, total) => `Showing ${shown} of ${total}.`,
  moreColumns: (n) => `${n} more ${n === 1 ? 'column is' : 'columns are'} in the full report.`,
  rowLimit: 'The report hit its row limit, so there may be more.',
  openReport: 'Open the full report',
  title: 'Identity Atlas',
  welcome: 'Ask me about access in plain language — English or Dutch. Try one of these:',
  welcomeFooter: 'Answers take up to a couple of minutes: the model runs on your own hardware, and nothing you ask leaves it.',
  notUnderstood: 'I could not turn that into a report.',
  notUnderstoodHint: 'These kinds of question work well:',
  unknownCaller: 'I cannot find your account in Identity Atlas.',
  unknownCallerHint: 'That usually means the directory has not been crawled since your account was created. Ask your Identity Atlas administrator to run the Entra ID crawler.',
  timeout: 'That took too long, so I stopped waiting.',
  timeoutHint: (s) => `I gave it ${s} seconds. The model runs on CPU here, and a complicated question can outlast that — try asking for something narrower.`,
  error: 'Something went wrong answering that.',
  errorHint: 'It has been logged. Try again, or ask your Identity Atlas administrator to look at the bot log.',
  // Greets by name when the token carried one. The typing indicator carries the
  // rest of the wait — there is deliberately no second 'still going' message.
  working: (name) => (name
    ? `Hi ${name}, got your message. I am building a report for you — this can take a couple of minutes. One moment...`
    : 'Got your message. I am building a report — this can take a couple of minutes. One moment...'),
  scopeCaveat: 'This report is not limited to your own people or resources — it covers everything in Identity Atlas.',
  fuzzy: (typed, matched) => `“${typed}” was matched to “${matched}”.`,
  examples: [
    'Which groups is Jan de Vries a member of?',
    'Who are the members of the Finance group?',
    'Which of my direct reports have access to the Finance SharePoint site?',
  ],
});

const NL = Object.freeze({
  understoodAs: 'Begrepen als',
  noResults: 'Hier voldoet niets aan.',
  records: (n) => `${n} ${n === 1 ? 'record' : 'records'}.`,
  showing: (shown, total) => `${shown} van ${total} getoond.`,
  moreColumns: (n) => `Er ${n === 1 ? 'staat nog 1 kolom' : `staan nog ${n} kolommen`} in het volledige rapport.`,
  rowLimit: 'Het rapport bereikte de maximale hoeveelheid rijen, er kunnen er meer zijn.',
  openReport: 'Open het volledige rapport',
  title: 'Identity Atlas',
  welcome: 'Stel me een vraag over toegang in gewone taal — Nederlands of Engels. Bijvoorbeeld:',
  welcomeFooter: 'Een antwoord kan een paar minuten duren: het model draait op je eigen hardware en je vraag verlaat die nooit.',
  notUnderstood: 'Ik kon daar geen rapport van maken.',
  notUnderstoodHint: 'Dit soort vragen werkt goed:',
  unknownCaller: 'Ik kan jouw account niet vinden in Identity Atlas.',
  unknownCallerHint: 'Meestal betekent dat dat de directory niet meer is uitgelezen sinds jouw account is aangemaakt. Vraag je Identity Atlas-beheerder om de Entra ID-crawler te draaien.',
  timeout: 'Dit duurde te lang, dus ik ben gestopt met wachten.',
  timeoutHint: (s) => `Ik heb ${s} seconden gewacht. Het model draait hier op CPU en een ingewikkelde vraag kan daar overheen gaan — probeer iets specifiekers.`,
  error: 'Er ging iets mis bij het beantwoorden.',
  errorHint: 'Het is gelogd. Probeer het opnieuw, of vraag je Identity Atlas-beheerder om in het botlog te kijken.',
  working: (name) => (name
    ? `Hoi ${name}, ik heb je bericht ontvangen. Ik ga een rapport voor je maken — dit kan een paar minuten duren. Moment...`
    : 'Ik heb je bericht ontvangen. Ik ga een rapport maken — dit kan een paar minuten duren. Moment...'),
  scopeCaveat: 'Dit rapport is niet beperkt tot jouw eigen mensen of resources — het gaat over alles in Identity Atlas.',
  fuzzy: (typed, matched) => `“${typed}” is gematcht op “${matched}”.`,
  examples: [
    'In welke groepen zit Jan de Vries?',
    'Wie zijn de leden van de groep Finance?',
    'Welke van mijn directe medewerkers hebben toegang tot de SharePoint-site Finance?',
  ],
});

const TABLES = { en: EN, nl: NL };

/**
 * The wording for a language, falling back to English for anything unknown.
 *
 * Object.hasOwn, like every other lookup keyed on outside input in this codebase
 * (see nlreports/spec.js): a plain `TABLES[language]` resolves 'constructor' and
 * '__proto__' to inherited members, so the bot would hand a FUNCTION to the card
 * renderer and every line of the reply would come out as `undefined`. The
 * language here is derived text rather than user input today, which is exactly
 * how this kind of thing survives to become a bug later.
 */
export function strings(language) {
  return Object.hasOwn(TABLES, String(language)) ? TABLES[language] : EN;
}

export { EN, NL };
