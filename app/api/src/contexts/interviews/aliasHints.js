// Context interviews — another name for the context that the model did not give.
//
//   aliasCandidates(claims, { transcript, contextName, aliases, intervieweeName }) → [{ name, norm, quote }]
//   aliasHintClaims(candidates, otherContextNames) → alias claims (confidence ALIAS_CONFIDENCE)
//
// People seldom say a unit's stored name ("HarbourOfficeNL"); they say "het
// Havenkantoor". A small model often leaves that out, so a rule proposes it —
// conservatively, as an alias claim of confidence 0.5 that waits for review
// like every other claim:
//
//   where   "het / de / the <Capitalised Name>" in the transcript (up to four
//           capitalised words; "Jan de Vries" is a surname, not one: an article
//           after a capitalised word is skipped), and the name a description claim
//           starts with ("Het Havenkantoor is …" — the model said that sentence is
//           about the context)
//   when    the name is in the transcript at least twice, or in the quote of the
//           first description claim (the first sentence about the context)
//   not     the context's own name or an alias it has (spacing ignored: "Harbour
//           Office" is "HarbourOffice"), an alias the model already gave, a person
//           (any word of a name a person claim or the interviewee carries), a name
//           a property claim gives (the systems it uses: "the Azure platform"),
//           a pronoun or article ("Het is …"), or another context's name or alias
//           (aliasHintClaims, with the names the store found)
//
// The quote is the sentence of the first occurrence (≤ MAX_WIDE_QUOTE), else the
// phrase itself. At most MAX_HINTS per run. Pure.

import { normalizeName } from '../../lib/nameMatch.js';
import { aliasesOf } from '../../lib/contextNameMatch.js';
import { foldForQuote, MIN_QUOTE } from './claims.js';
import { locateQuote } from './quoteOffsets.js';
import { sentenceAt, MAX_WIDE_QUOTE } from './sentences.js';

export const ALIAS_CONFIDENCE = 0.5;
export const MAX_HINTS = 3;

// An article, then where a name may start: "het Havenkantoor", "the Port Desk".
const ARTICLE = /(?<![\p{L}\p{N}])(?:[Hh]et|[Dd]e|[Tt]he)[ \t]+(?=\p{Lu})/gu;
const LEADING_ARTICLE = /^(?:[Hh]et|[Dd]e|[Tt]he)[ \t]+/u;
// What follows a name a description starts with: "Het Havenkantoor is …".
const LEADING_VERB = /^\s+(?:is|was|zijn|heeft|has|have|doet|does|werkt|works)(?![\p{L}])/u;
const CAP_WORD = /^\p{Lu}[\p{L}\p{N}&-]*/u;
const GAP = /^[ \t]+/;
const MAX_NAME_WORDS = 4;
const ARTICLE_BEFORE = /(?:[Hh]et|[Dd]e|[Tt]he)\s+$/u;
const LETTER = /[\p{L}\p{N}]/u;
const PRONOUNS = new Set(['het', 'de', 'the', 'dit', 'dat', 'deze', 'die', 'er', 'daar', 'ik', 'wij', 'we', 'zij', 'ze', 'hij', 'u', 'jij', 'it', 'this', 'that', 'there', 'they', 'i', 'he', 'she', 'you']);
const PERSON_KINDS = new Set(['role', 'roleHistory', 'membership']);

const compact = (s) => normalizeName(s).replace(/\s+/g, '');
// Where the name stands in the text as a whole word.
function occurrences(text, name) {
  const at = [];
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
    if (!LETTER.test(text[i - 1] ?? '') && !LETTER.test(text[i + name.length] ?? '')) at.push(i);
  }
  return at;
}
const count = (text, name) => occurrences(text, name).length;

// The name at text[i]: up to MAX_NAME_WORDS capitalised words on one line, and where it ends.
function nameAt(text, i) {
  const words = [];
  let at = i;
  while (words.length < MAX_NAME_WORDS) {
    const w = CAP_WORD.exec(text.slice(at, at + 100));
    if (!w) break;
    words.push(w[0]);
    at += w[0].length;
    const gap = GAP.exec(text.slice(at, at + 20));
    if (!gap || !CAP_WORD.test(text.slice(at + gap[0].length, at + gap[0].length + 100))) break;
    at += gap[0].length;
  }
  return { name: words.join(' '), end: at };
}

// The name a description starts with, when a verb follows it.
function leadingName(value) {
  const text = String(value ?? '');
  const article = LEADING_ARTICLE.exec(text);
  const { name, end } = nameAt(text, article ? article[0].length : 0);
  return name && LEADING_VERB.test(text.slice(end)) ? name : null;
}

// The capitalised word before an article: "Jan de Vries" names a person.
const afterCapitalisedWord = (text, at) => /(?:^|\s)\p{Lu}[\p{L}]*\s+$/u.test(text.slice(Math.max(0, at - 40), at));

function namesIn(transcript) {
  const out = [];
  for (const m of transcript.matchAll(ARTICLE)) {
    if (!afterCapitalisedWord(transcript, m.index)) out.push(nameAt(transcript, m.index + m[0].length).name);
  }
  return out;
}

function firstDescription(claims, transcript) {
  let first = null;
  for (const c of claims) {
    if (c.claimKind !== 'description' || !c.quote) continue;
    const at = locateQuote(transcript, c.quote)?.start ?? Infinity;
    if (!first || at < first.at) first = { claim: c, at };
  }
  return first?.claim ?? null;
}

function excludedWords(claims, intervieweeName) {
  const words = new Set();
  const people = [intervieweeName, ...claims.filter(c => PERSON_KINDS.has(c.claimKind)).map(c => c.subjectName)];
  for (const p of people) for (const w of normalizeName(p).split(' ')) if (w) words.add(w);
  return words;
}

function quoteFor(transcript, name) {
  const i = occurrences(transcript, name)[0];
  const article = ARTICLE_BEFORE.exec(transcript.slice(Math.max(0, i - 8), i));
  const start = article ? i - article[0].length : i;
  const sentence = sentenceAt(transcript, { start, end: i + name.length });
  const wide = foldForQuote(sentence.text);
  if (wide.length <= MAX_WIDE_QUOTE) return wide;
  const phrase = foldForQuote(transcript.slice(start, i + name.length));
  return phrase.length >= MIN_QUOTE ? phrase : null;
}

export function aliasCandidates(claims, { transcript, contextName, aliases = [], intervieweeName = null }) {
  const text = String(transcript ?? '');
  const known = new Set([contextName, ...aliasesOf({ aliases }),
    ...claims.filter(c => c.claimKind === 'alias').map(c => c.value)].map(compact).filter(Boolean));
  const people = excludedWords(claims, intervieweeName);
  const properties = claims.filter(c => c.claimKind === 'property').map(c => normalizeName(c.value)).join(' | ');
  const first = firstDescription(claims, text);
  const firstText = first ? `${first.quote} ${first.value}` : '';
  const named = [...namesIn(text),
    ...claims.filter(c => c.claimKind === 'description').map(c => leadingName(c.value)).filter(Boolean)];

  const out = [];
  const seen = new Set();
  for (const name of named) {
    const norm = normalizeName(name);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    if (!isNewName(name, norm, { known, people, properties })) continue;
    if (!saidEnough(text, firstText, name)) continue;
    const quote = quoteFor(text, name);
    if (quote) out.push({ name, norm, quote });
  }
  return out;
}

// Not a pronoun, a name the context already has, a person or a property value.
function isNewName(name, norm, { known, people, properties }) {
  const words = norm.split(' ');
  if (PRONOUNS.has(words[0]) || known.has(compact(name))) return false;
  return !words.some(w => people.has(w)) && !properties.includes(norm);
}

// Said twice, or once in the first description of the context.
function saidEnough(text, firstText, name) {
  const times = count(text, name);
  return times >= 2 || (times === 1 && count(firstText, name) > 0);
}

export function aliasHintClaims(candidates, otherContextNames = []) {
  const other = new Set(otherContextNames.map(normalizeName));
  return candidates.filter(c => !other.has(c.norm)).slice(0, MAX_HINTS).map(c => ({
    claimKind: 'alias', subjectKind: 'Context', subjectName: null, principalId: null, identityId: null, subjectMatch: null,
    attribute: null, value: c.name, periodFrom: null, periodTo: null, periodText: null,
    quote: c.quote, confidence: ALIAS_CONFIDENCE, relevance: 'high',
  }));
}
