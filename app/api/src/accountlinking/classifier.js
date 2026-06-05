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

/**
 * Parse a person name into { given, surname, initial, key }.
 * Handles "Surname, Given" and "Given Surname"; falls back to explicit
 * givenName/surname fields when the display name yields nothing.
 * `key` is the order-independent surname+given token (for candidate indexing).
 */
export function parseName(displayName, givenName, surname) {
  const dn = String(displayName || '').replace(QUALIFIER_RE, ' ').trim();
  let given = '';
  let sur = '';
  if (dn.includes(',')) {
    const [a, b] = dn.split(',');
    sur = a;
    given = (b || '').trim().split(/\s+/)[0] || '';
  } else if (dn) {
    const t = dn.split(/\s+/).filter(Boolean);
    if (t.length >= 2) { given = t[0]; sur = t[t.length - 1]; }
    else if (t.length === 1) { sur = t[0]; }
  }
  if (!sur && surname) sur = surname;
  if (!given && givenName) given = givenName;
  given = normToken(given);
  sur = normToken(sur);
  return {
    given,
    surname: sur,
    initial: given.slice(0, 1),
    key: sur ? [sur, given].filter(Boolean).sort().join('|') : '',
  };
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
