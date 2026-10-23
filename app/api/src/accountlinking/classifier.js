// Identity Atlas — Account classifier + match helpers.
//
// Pure, dependency-light helpers shared by the linking engine and the
// orphaned-accounts context plugin. Patterns are admin-editable so we compile
// them with RE2 (linear-time, ReDoS-safe) — the same choice the risk-scoring
// engine makes.

import RE2 from 're2';
import { DEFAULT_RULES } from './defaultRules.js';

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

/** Normalise a display name to a comparable token (lowercased, suffixes removed, alnum only). */
export function normalizeName(value, stripSuffixes = []) {
  if (!value) return '';
  let s = String(value).toLowerCase().trim();
  for (const suf of stripSuffixes) {
    const sl = String(suf).toLowerCase();
    if (sl && s.includes(sl)) s = s.split(sl).join(' ');
  }
  return s.replace(/[^a-z0-9]+/g, '');
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
const normToken = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

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

/** A structured givenName/surname column: clean already, bar the odd title. */
const parseField = (value) => normToken(stripTitles(tokenize(value), 1).join(' '));

/**
 * Parse the free-text display name into its given/surname halves.
 * Handles "Surname, Given" and "Given Surname".
 */
function parseDisplayName(dn) {
  if (dn.includes(',')) {
    const [a, b] = dn.split(',');
    // The comma already delimits the surname, so it keeps every token it has.
    return { given: stripTitles(tokenize(b), 1)[0] || '', sur: stripTitles(tokenize(a), 1).join(' ') };
  }
  const t = stripTitles(tokenize(dn), Math.min(2, tokenize(dn).length));
  if (t.length === 1) return { given: '', sur: t[0] };
  if (!t.length) return { given: '', sur: '' };
  // The surname runs from the first particle to the end; with no particle it is
  // the last token only, so middle names ("John Michael Doe") still collapse.
  let start = -1;
  for (let i = 1; i < t.length - 1; i++) {
    if (startsSurname(t[i])) { start = i; break; }
  }
  return { given: t[0], sur: start === -1 ? t[t.length - 1] : t.slice(start).join(' ') };
}

/**
 * One parsed name: { given, surname, initial, key }. `key` is the
 * order-independent surname+given token used for candidate indexing.
 */
const parsedName = (given, sur) => ({
  given,
  surname: sur,
  initial: given.slice(0, 1),
  key: sur ? [sur, given].filter(Boolean).sort().join('|') : '',
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
 * @returns {Array<{given: string, surname: string, initial: string, key: string}>}
 */
export function nameVariants(displayName, givenName, surname) {
  const dn = String(displayName || '').replace(QUALIFIER_RE, ' ').trim();
  const parsed = parseDisplayName(dn);
  const dGiven = normToken(parsed.given);
  const dSur = normToken(parsed.sur);
  const fGiven = parseField(givenName);
  const fSur = parseField(surname);

  const out = [];
  const add = (given, sur) => {
    if (!given && !sur) return;
    if (out.some(v => v.given === given && v.surname === sur)) return;
    out.push(parsedName(given, sur));
  };
  add(fGiven, fSur);                       // the structured columns on their own
  add(fGiven || dGiven, fSur || dSur);     // a column for one half, the display name for the other
  add(dGiven, dSur);                       // the display name on its own
  return out;
}

/**
 * Compare two parsed names. Returns the strongest match level:
 *   'full'           — same surname AND same given name
 *   'surnameInitial' — same surname AND same given initial
 *   'none'           — otherwise (surname-only is treated as no match)
 */
export function nameMatchLevel(a, b) {
  if (!a.surname || !b.surname || a.surname !== b.surname) return 'none';
  if (a.given && b.given && a.given === b.given) return 'full';
  if (a.initial && b.initial && a.initial === b.initial) return 'surnameInitial';
  return 'none';
}

const LEVEL_RANK = { none: 0, surnameInitial: 1, full: 2 };

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
