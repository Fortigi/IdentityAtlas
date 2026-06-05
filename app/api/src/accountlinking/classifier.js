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
