// Identity Atlas — folding a letter to its ASCII base letter.
//
// Account linking compares a name to a login, an email local part or an ERP
// export, and one side of that comparison is routinely plain ASCII: a directory
// spells Sevgi Doğan's admin account `adm-sdogan`, an ERP writes `Danielle`.
// Reducing a name by *deleting* everything outside [a-z0-9] therefore deletes
// the very letter the two spellings have to agree on — "Doğan" becomes `doan`,
// "Daniëlle" becomes `danille` — and the account can never be placed (#1480).
//
// Folding each letter to its base letter is what lets the two meet in the
// middle. It happens in one place because the name side and the login/email
// side must fold identically: a fold applied to only one of them moves the two
// further apart than no fold at all.
//
// This is comparison-only. Nothing here is persisted — `IdentityMembers` keeps
// the raw `displayName` — and a display slug (`reports/export.js`) or a
// Unicode-preserving reference token (`nlreports/references.js`) is a different
// contract that must not be folded through here.

/**
 * The letters NFKD leaves whole, because they are not a base letter plus a
 * mark: a stroked or dotless letter, and the ligatures a language writes as
 * two letters. Each needs naming, so they are listed rather than derived.
 * Keyed lower-cased — `foldDiacritics` lower-cases before it looks them up.
 */
const UNDECOMPOSED = {
  ı: 'i', ł: 'l', ø: 'o', đ: 'd', ß: 'ss', æ: 'ae', œ: 'oe', þ: 'th', ð: 'd',
};

/** Combining marks, which is what NFKD splits an accented letter's accent into. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * One value lower-cased and folded to its ASCII base letters, separators and
 * punctuation left in place.
 *
 * Lower-casing comes first because it is what exposes some of the marks:
 * Turkish `İ` lower-cases to `i` plus a combining dot, so the dot is only
 * there to strip afterwards. The map is then read per character rather than
 * through a derived character class, so the letters are listed exactly once.
 */
export function foldDiacritics(value) {
  const decomposed = String(value || '').toLowerCase().normalize('NFKD').replace(COMBINING_MARKS, '');
  return [...decomposed].map(c => UNDECOMPOSED[c] ?? c).join('');
}

/**
 * The comparison token one value reduces to: folded, then everything outside
 * [a-z0-9] dropped. The strip stays as the final guard — a script the fold has
 * no base letter for still cannot reach a comparison as half a letter.
 */
export function foldedToken(value) {
  return foldDiacritics(value).replace(/[^a-z0-9]+/g, '');
}
