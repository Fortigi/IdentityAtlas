// Identity Atlas — Account classifier + match helpers.
//
// Pure, dependency-light helpers shared by the linking engine and the
// orphaned-accounts context plugin. Patterns are admin-editable so we compile
// them with RE2 (linear-time, ReDoS-safe) — the same choice the risk-scoring
// engine makes.

import RE2 from 're2';
import { DEFAULT_RULES } from './defaultRules.js';
import { isInitialsHalf, nameInitials, initialsAgree } from './initials.js';
import { foldedToken } from './fold.js';

/** Local part of an email/UPN, lower-cased. Principals store mail-or-UPN in `email`. */
export function emailLocalPart(email) {
  if (!email) return '';
  const s = String(email).toLowerCase().trim();
  const at = s.indexOf('@');
  return at === -1 ? s : s.slice(0, at);
}

/** Strip the first matching known prefix (e.g. "adm-") from a local part. */
export function stripKnownPrefixes(localPart, prefixes = []) {
  if (!localPart) return '';
  for (const p of prefixes) {
    const pl = String(p).toLowerCase();
    if (pl && localPart.startsWith(pl)) return localPart.slice(pl.length);
  }
  return localPart;
}

/**
 * Normalise a display name to a comparable token: lowercased, suffixes removed,
 * letters folded to their ASCII base (see `foldDiacritics`), alnum only.
 */
export function normalizeName(value, stripSuffixes = []) {
  if (!value) return '';
  let s = String(value).toLowerCase().trim();
  for (const suf of stripSuffixes) {
    const sl = String(suf).toLowerCase();
    if (sl && s.includes(sl)) s = s.split(sl).join(' ');
  }
  return foldedToken(s);
}

/** Compile accountTypeRules once (lowest priority first). */
export function compileAccountTypeRules(rules = DEFAULT_RULES) {
  const out = [];
  for (const r of (rules.accountTypeRules || [])) {
    const regexes = [];
    for (const p of (r.patterns || [])) {
      try { regexes.push(new RE2(p, 'i')); } catch { /* skip malformed pattern */ }
    }
    out.push({ accountType: r.accountType, priority: r.priority ?? 99, regexes, raw: r.patterns || [] });
  }
  out.sort((a, b) => a.priority - b.priority);
  return out;
}

/**
 * Classify a principal into an account type.
 * @returns {{ accountType: string, pattern: string|null }}
 */
export function classifyAccount(principal, rules = DEFAULT_RULES) {
  const email = (principal.email || '').toLowerCase();
  const name = (principal.displayName || '').toLowerCase();
  const ext = principal.extendedAttributes || {};
  const userType = String(ext.userType ?? ext.usertype ?? '').toLowerCase();

  // Directory metadata is the strongest guest signal.
  if (userType === 'guest' || email.includes('#ext#')) {
    return { accountType: 'Guest', pattern: userType === 'guest' ? 'userType=Guest' : '#ext#' };
  }

  const compiled = Array.isArray(rules.__compiled) ? rules.__compiled : compileAccountTypeRules(rules);
  const haystacks = [email, name];
  for (const rule of compiled) {
    for (let i = 0; i < rule.regexes.length; i++) {
      if (haystacks.some(h => h && rule.regexes[i].test(h))) {
        return { accountType: rule.accountType, pattern: rule.raw[i] };
      }
    }
  }
  return { accountType: 'Secondary', pattern: null };
}

// ─── Name parsing (for graded name matching) ──────────────────────
// Role/company qualifiers carried in display names: "(OGD)", "[extern]",
// "(ADM-azure)". Stripped before parsing so the same person under different
// roles reduces to the same name.
const QUALIFIER_RE = /\([^)]*\)|\[[^\]]*\]/g;
const normToken = foldedToken;

// Pre- and post-nominal titles that HR and directory display names routinely
// carry ("drs. Anna Bakker", "Jan de Vries MSc"). A title is not a name token:
// parsed as one, the owner is indexed under the wrong name, stops matching her
// own accounts, and they link to an untitled namesake instead. Matched after
// normToken, so "drs.", "Drs" and "DRS" all hit.
const TITLES = new Set([
  // Pre-nominals (Dutch / Belgian / German / English)
  'dr', 'drs', 'ir', 'ing', 'mr', 'mrs', 'ms', 'miss', 'prof', 'em', 'bc',
  'lic', 'mgr', 'jhr', 'jkvr', 'dipl', 'hon', 'rev',
  // Post-nominal degrees and registrations
  'msc', 'bsc', 'ma', 'ba', 'bba', 'mba', 'emba', 'beng', 'meng', 'pdeng',
  'llm', 'llb', 'phd', 'dphil', 'mphil', 'md', 'jd', 'bed', 'med', 'edd',
  'ra', 'rc', 'ea', 'cpa', 'cisa', 'cissp', 'cia', 'cma', 'pmp',
]);

// Surname particles ("van der Steen", "ter Horst", "in 't Veld"). The surname
// starts at the first of these, so the particles stay part of it — dropped,
// every "van den Berg" in the tenant collapses onto "berg" and a surname match
// stops meaning anything.
const PARTICLES = new Set([
  'van', 'von', 'de', 'den', 'der', 'des', 'du', 'del', 'della', 'di', 'da',
  'do', 'dos', 'das', 'la', 'le', 'el', 'al', 'ten', 'ter', 'te', 'tot',
  'op', 'aan', 'in', 'uit', 'het', 'mac', 'mc', 'af', 'av', 'bin', 'ibn',
]);

const tokenize = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);
const isTitle = (tok) => TITLES.has(normToken(tok));
const isParticle = (tok) => PARTICLES.has(normToken(tok));

/**
 * Whether a token begins the surname: a bare particle, or a hyphenated compound
 * whose tail is one ("Schilder-van" in "Schilder-van der Steen" — a different
 * family from "van der Steen", which the last-token rule conflated).
 */
function startsSurname(tok) {
  if (isParticle(tok)) return true;
  const parts = String(tok).split('-').filter(Boolean);
  return parts.length > 1 && isParticle(parts[parts.length - 1]);
}

/**
 * The shorter surnames a login convention writes in place of the whole one,
 * normalised and excluding the whole surname itself.
 *
 * A surname is kept whole for *matching* names — dropped particles collapse every
 * "van den Berg" in the tenant onto "berg" (see `PARTICLES`) — but a provisioning
 * convention does reduce it when it spells a login, in two ways that account for
 * every shape measured on the reporting tenant (#1468):
 *
 *   - the particles are dropped: `van Dongen` → `dongen`, so `adm-ddongen`;
 *   - a hyphenated double surname keeps one half: `van der Velde-Bierma` →
 *     `vandervelde` / `velde` / `bierma`, so `adm-wvelde`, and both halves
 *     reduced together → `veldebierma`.
 *
 * Both are built from the surname's own shape, so only a surname that HAS a
 * hyphenated half offers one: a plain `Becker` reduces to nothing and is
 * therefore never a half-form claimant for `abecker` — only the Andrea
 * Neumann-Becker the half was taken from is, and she keeps her whole-surname
 * spelling too.
 *
 * These are deliberately NOT name keys: they are only ever spelled as the weakest
 * grade of login form, where a person actually called the reduced name outranks
 * the person whose name a convention reduced to it.
 *
 * @returns {string[]}
 */
function surnameReductions(raw) {
  const halves = String(raw || '').split('-').map(h => tokenize(h)).filter(words => words.length);
  const bare = (words) => words.filter(w => !isParticle(w));
  const out = new Set();
  for (const words of halves) {
    out.add(normToken(words.join(' ')));       // the half, particles kept
    out.add(normToken(bare(words).join(' '))); // the half, particles dropped
  }
  out.add(normToken(halves.flatMap(bare).join(' '))); // every half, particles dropped
  out.delete('');
  out.delete(normToken(raw));
  return [...out];
}

/**
 * Drop leading and trailing title tokens, never trimming below `keep` tokens.
 * The floor is what keeps a genuine short surname that happens to spell a
 * degree ("Jan Ma") from being stripped down to nothing.
 */
function stripTitles(tokens, keep) {
  let t = tokens;
  while (t.length > keep && isTitle(t[0])) t = t.slice(1);
  while (t.length > keep && isTitle(t[t.length - 1])) t = t.slice(0, -1);
  return t;
}

/** A structured givenName/surname column with its titles dropped, words intact. */
const rawField = (value) => stripTitles(tokenize(value), 1).join(' ');

/**
 * The one token a given-name half collapses to.
 *
 * A half that spells **initials** keeps all of them (`L. R.` and `L.R.` both
 * reduce to `lr`), so the same person written either way reduces to the same
 * name; a half that spells a name keeps its first word, as it always has, so an
 * inconsistently-recorded middle name still collapses ("John Michael Doe" is
 * `john`, not `johnmichael`).
 */
const givenHalf = (words) => (isInitialsHalf(words) ? words.join('') : (words[0] || ''));

/**
 * Parse the free-text display name into its given/surname halves.
 * Handles "Surname, Given" and "Given Surname".
 *
 * `givenWords` is the given half's own words, which is what the initials are
 * read from — they do not survive the collapse into `given` (#1455).
 */
function parseDisplayName(dn) {
  if (dn.includes(',')) {
    const [a, b] = dn.split(',');
    // The comma already delimits the surname, so it keeps every token it has.
    const givenWords = stripTitles(tokenize(b), 1);
    return { given: givenHalf(givenWords), givenWords, sur: stripTitles(tokenize(a), 1).join(' ') };
  }
  const all = tokenize(dn);
  const t = stripTitles(all, Math.min(2, all.length));
  if (!t.length) return { given: '', givenWords: [], sur: '' };
  if (t.length === 1) return { given: '', givenWords: [], sur: t[0] };
  // The surname runs from the first particle to the end; with no particle it is
  // the last token only, so middle names ("John Michael Doe") still collapse.
  let start = -1;
  for (let i = 1; i < t.length - 1; i++) {
    if (startsSurname(t[i])) { start = i; break; }
  }
  const surStart = start === -1 ? t.length - 1 : start;
  const givenWords = t.slice(0, surStart);
  return { given: givenHalf(givenWords), givenWords, sur: t.slice(surStart).join(' ') };
}

/**
 * One parsed name: { given, surname, initial, initials, key, variant,
 * reducedSurnames }.
 * `key` is the order-independent surname+given token used for candidate indexing.
 * `initials` is every initial the name exposes, in order (see `nameInitials`):
 * one letter for a single given name, the whole sequence for `L.R.` or for a
 * source that records several given names. `initial` is its first letter.
 * `reducedSurnames` are the shorter spellings of the surname a login convention
 * writes (see `surnameReductions`) — read only by `loginNameForms`, never keyed.
 *
 * `variant` says which of the person's names this is:
 *   'inUse' — the name they are known by, which is what their accounts are
 *             spelled with: the display name's halves, or a column the display
 *             name does not contradict
 *   'birth' — a surname only the structured column holds while the display name
 *             spells a different one: the birth surname behind a partner name
 *             or a double name
 */
const parsedName = (given, sur, variant, surWords, givenWords) => ({
  given,
  surname: sur,
  initial: given.slice(0, 1),
  initials: nameInitials(givenWords, given),
  key: sur ? [sur, given].filter(Boolean).sort().join('|') : '',
  variant,
  reducedSurnames: surnameReductions(surWords),
});

/**
 * Every name a person may be known by, deduped.
 *
 * There are two independent sources and neither is authoritative, so **both**
 * are kept rather than one preferred over the other:
 *
 *   - the structured `givenName` / `surname` columns, and
 *   - the parsed free-text `displayName`.
 *
 * HR sources routinely hold the **birth surname** in the `surname` column while
 * the display name — and the accounts — carry the **name in use**: a partner
 * name or a double name. Reading only the columns therefore unlinks everyone
 * whose name in use differs from their birth name, and reading only the display
 * name re-opens the title/particle mis-parse (a title parsed as the surname).
 * A person is indexed under all of their names and a match on any one counts.
 *
 * Each name also records *which* of the person's names it is (see `parsedName`),
 * so a tie between two people can be read as the unequal thing it usually is:
 * one of them is actually called that, the other only was.
 *
 * @returns {Array<{given: string, surname: string, initial: string, initials: string[],
 *   key: string, variant: string, reducedSurnames: string[]}>}
 */
export function nameVariants(displayName, givenName, surname) {
  const dn = String(displayName || '').replace(QUALIFIER_RE, ' ').trim();
  const parsed = parseDisplayName(dn);
  const dGiven = normToken(parsed.given);
  const dSur = normToken(parsed.sur);
  // The given name is kept both collapsed (for comparison) and as its own words,
  // which is what every initial beyond the first survives in: a column holding
  // "Laura Renée" is the `L.R.` an ERP shows, and only before the collapse.
  const fGivenWords = tokenize(rawField(givenName));
  const fGiven = normToken(fGivenWords.join(' '));
  // The surname is kept both normalised (for comparison) and as its own words,
  // which is what the particles and the hyphen of a double name survive in.
  const fSurWords = rawField(surname);
  const fSur = normToken(fSurWords);

  // The column surname is a *birth* surname only where the display name spells
  // a different one. With no display surname to contradict it (a source that
  // fills the columns and nothing else) the column is simply the name in use.
  const columnIsBirthName = !!dSur && dSur !== fSur;
  const variantOf = (sur) => (sur && sur === fSur && columnIsBirthName ? 'birth' : 'inUse');

  const out = [];
  const add = (given, sur, surWords, givenWords) => {
    if (!given && !sur) return;
    if (out.some(v => v.given === given && v.surname === sur)) return;
    out.push(parsedName(given, sur, variantOf(sur), surWords, givenWords));
  };
  add(fGiven, fSur, fSurWords, fGivenWords); // the structured columns on their own
  // A column for one half, the display name for the other.
  add(fGiven || dGiven, fSur || dSur, fSur ? fSurWords : parsed.sur,
    fGiven ? fGivenWords : parsed.givenWords);
  add(dGiven, dSur, parsed.sur, parsed.givenWords); // the display name on its own
  return out;
}

// ─── Login name forms (for a login that spells a name) ────────────
//
// A login is a name, not just an address: `adm-fhogenbirk` says "the F.
// Hogenbirk of this tenant". Reading it as an address only — strip the prefix,
// then demand the remainder equal the person's email local part exactly —
// recognises one provisioning convention and nothing else, so an admin account
// whose owner's mailbox is `f.h.hogenbirk` never finds her (#1454). Dropping the
// separators cannot bridge it either: `f.h.hogenbirk` reduces to `fhhogenbirk`,
// not to `fhogenbirk`. The login has to be read against the forms a convention
// writes a *name* in.

/**
 * The comparison token an account's login reduces to: the local part with a
 * known administrative prefix (`adm-`, `ext-`, …) removed, then lower-cased with
 * every separator dropped. Prefixes are stripped first because they carry the
 * separator that delimits them.
 */
export function loginToken(email, stripPrefixes = []) {
  return normToken(stripKnownPrefixes(emailLocalPart(email), stripPrefixes));
}

/**
 * The same login with a trailing digit run dropped, or `''` when it carries
 * none.
 *
 * Numbering is how a convention tells two namesakes' logins apart — `svisser2`
 * is the second S. Visser's, and the `2` is no part of anybody's name — so a
 * numbered login has to be read as the name it numbers (#1468). It is a
 * *fallback* the lookup falls through to, never a rewrite inside `loginToken`:
 * digits can equally be part of an address a person's own mailbox uses (`jan2`),
 * and stripping them there would hand that account to every Jan Jansen in the
 * tenant instead of to its owner.
 */
export function unnumberedLoginToken(token) {
  const t = String(token || '');
  const bare = t.replace(/[0-9]+$/, '');
  return bare === t ? '' : bare;
}

/**
 * The spellings a login is looked up under, strongest first: the login as
 * written, then — only as a fallback — the name a trailing digit run numbers
 * (see `unnumberedLoginToken`).
 *
 * `numbered` marks that fallback, because it is read on narrower terms than the
 * login itself: see `numberedAwayFrom`.
 *
 * @returns {Array<{ form: string, numbered: boolean }>}
 */
export function loginSpellings(token) {
  const t = String(token || '');
  return [{ form: t, numbered: false }, { form: unnumberedLoginToken(t), numbered: true }]
    .filter(s => s.form);
}

/**
 * Whether the number in a numbered login points *away* from this person: the
 * un-numbered spelling is their own address, and numbering is precisely how a
 * convention says the numbered account is somebody else's (#1468).
 *
 * `p.h.nanhoe2` is not the `p.h.nanhoe` mailbox owner's account — it exists to
 * be told apart from hers — so the form it reduces to is no claim on her, and
 * the same holds for an admin login (`adm-skleef2` against the person whose own
 * address is `skleef`). It stays evidence that the account is *some* S. Kleef's,
 * which is why this rules her out as a claimant rather than cancelling the
 * match: with nobody else answering to the form, the account is held for review.
 *
 * @param {object} person  the identity being weighed
 * @param {{ form: string, numbered: boolean }} spelling  one `loginSpellings` entry
 */
export function numberedAwayFrom(person, spelling) {
  return !!spelling.numbered && normToken(emailLocalPart(person.email)) === spelling.form;
}

/**
 * The login forms a person's name can be written as, graded by how much of the
 * name each form carries:
 *
 *   full    — the whole name: given name + surname, or the local part of the
 *             person's own address (the convention their mailbox already uses,
 *             which is normally their whole name: `f.h.hogenbirk`)
 *   initial — given initial + surname, which keeps one letter of the given name
 *             and so can answer for more than one person: `pmunck` fits every
 *             P. Munck in the tenant
 *   loose   — given initial + a surname a convention has shortened: the particles
 *             dropped (`ddongen` for Daniëlle van Dongen) or one half of a double
 *             surname (`wvelde` for W. van der Velde-Bierma). See
 *             `surnameReductions`
 *
 * The three are read from every name the person is known by (see `nameVariants`),
 * and each form records which of those names it came from, so a login two people
 * match can still be placed when only one of them actually goes by that name.
 *
 * `loose` is a grade of its own rather than more entries in `initial`, because a
 * person genuinely called the shortened name must outrank one whose name a
 * convention shortened to it: the D. Dongen of the tenant answers `ddongen` at
 * `initial`, Daniëlle van Dongen only at `loose`. Merged into one grade the two
 * would tie and neither could be placed (#1460, #1468).
 *
 * The grade says what the form *carries*, never where it was read from, so a
 * person whose own address is already the short form (`j.jansen` for Jan Jansen)
 * is listed at `initial` like everybody else spelled that way — read as a full
 * form it would outrank the real initial-level claimants and silently break the
 * tie between two people who are genuinely called the same thing. For the same
 * reason a form carrying the whole name is never also an initial form, which a
 * one-token given name makes coincide.
 *
 * @returns {{ full: Map<string, 'inUse'|'birth'>, initial: Map<string, 'inUse'|'birth'>,
 *   loose: Map<string, 'inUse'|'birth'> }}
 */
export function loginNameForms(person) {
  const full = new Map();
  const initial = new Map();
  const loose = new Map();
  // The stronger variant of a form wins: a name the person is in-use known by is
  // not also recorded as a birth name, whichever order their names come in.
  const keep = (map, form, variant) => {
    if (!form) return;
    if (map.get(form) !== 'inUse') map.set(form, variant);
  };
  for (const v of nameVariants(person.displayName, person.givenName, person.surname)) {
    if (!v.surname) continue; // a bare given name is no form at all
    keep(full, v.given && v.given + v.surname, v.variant);
    keep(initial, v.initial && v.initial + v.surname, v.variant);
    for (const sur of v.reducedSurnames) keep(loose, v.initial && v.initial + sur, v.variant);
  }
  const address = normToken(emailLocalPart(person.email));
  if (!initial.has(address) && !loose.has(address)) keep(full, address, 'inUse');
  // One form is never listed at two grades, which a one-token given name or a
  // reduction that spells another of the person's names makes coincide: listed
  // twice, the person is their own rival at the weaker grade.
  for (const form of full.keys()) { initial.delete(form); loose.delete(form); }
  for (const form of initial.keys()) loose.delete(form);
  return { full, initial, loose };
}

/** The login-form grades, strongest first. */
export const LOGIN_FORM_GRADES = ['full', 'initial', 'loose'];

/**
 * Which of a person's login forms an account's login token spells — the
 * strongest first, since a form that carries the whole name is better evidence
 * than one that carries an initial, and one that carries a shortened surname is
 * weaker still.
 *
 * The exact login is read first and the number a namesake's login carries is
 * dropped only when it spells nobody's form, so `jan2` stays the `jan2` mailbox
 * while `svisser2` reads as the S. Visser it numbers.
 *
 * What the number says about *which* S. Visser is not asked here: this reports
 * that the login spells the person's name, which is what makes the account worth
 * comparing to her at all. `numberedAwayFrom` is weighed by the uniqueness guard,
 * so an account the number points away from is still scored — and so held for
 * review — rather than vanishing from the run with nothing to act on.
 *
 * @returns {'full'|'initial'|'loose'|'none'}
 */
export function loginFormMatch(token, person) {
  if (!token) return 'none';
  const forms = loginNameForms(person);
  for (const { form } of loginSpellings(token)) {
    for (const grade of LOGIN_FORM_GRADES) {
      if (forms[grade].has(form)) return grade;
    }
  }
  return 'none';
}

/**
 * Compare two parsed names. Returns the strongest match level:
 *   'full'            — same surname AND same given name
 *   'surnameInitials' — same surname AND every initial, where both sides state
 *                       at least two of them: `Buskes, L.R.` and Laura Renée
 *                       Buskes. Two letters in agreement is much stronger
 *                       evidence than one, and strong enough to be worth its own
 *                       rung (#1455)
 *   'surnameInitial'  — same surname AND same given initial
 *   'none'            — otherwise (surname-only is treated as no match)
 *
 * Where both sides state two or more initials the comparison is **all of them
 * or nothing** (P1/R1b): `L.R.` and `L.W.` are not a weaker match on the shared
 * `L.`, they are a statement that this is somebody else. Unequal counts stay
 * neutral in either direction and fall through to the single-initial rung (R1).
 */
export function nameMatchLevel(a, b) {
  if (!a.surname || !b.surname || a.surname !== b.surname) return 'none';
  if (a.given && b.given && a.given === b.given) return 'full';
  if (a.initials.length >= 2 && b.initials.length >= 2) {
    return initialsAgree(a.initials, b.initials) ? 'surnameInitials' : 'none';
  }
  if (a.initial && b.initial && a.initial === b.initial) return 'surnameInitial';
  return 'none';
}

const LEVEL_RANK = { none: 0, surnameInitial: 1, surnameInitials: 2, full: 3 };

/**
 * The strongest `nameMatchLevel` over every pair of names the two sides are
 * known by — a match on the name in use counts as much as one on the birth
 * name, whichever source each side happens to carry it in.
 */
export function bestNameMatch(aVariants, bVariants) {
  let best = 'none';
  for (const a of aVariants) {
    for (const b of bVariants) {
      const level = nameMatchLevel(a, b);
      if (LEVEL_RANK[level] > LEVEL_RANK[best]) best = level;
      if (best === 'full') return best;
    }
  }
  return best;
}
