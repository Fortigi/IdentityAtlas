// Context upload — the values in one cell of a list.
//
//   splitValues(cell)  → every value of a members / Responsibles cell
//   singleValue(cell)  → the one value of an owner cell, or of a long-format row
//   cleanValue(token)  → one value as the matcher should see it
//
// Lists exported from SharePoint write a person or lookup column as
// "Alice Example;#27;#Bob Sample;#16" — the shown value, then the item id of the
// looked-up row, joined with ";#". A single value is "Alice Example;#27". The
// ids say nothing about who is meant, so they are dropped. A person column may
// also hold the account's claim ("i:0#.f|membership|alice@example.com") or a
// mail-style "Alice Example <alice@example.com>": both become the address,
// which identifies the account better than the name does.

export const LOOKUP_SEPARATOR = ';#';

const isDigits = (s) => /^\d+$/.test(s);
const parts = (text, re) => text.split(re).map(s => s.trim()).filter(Boolean);

/** Does the cell hold a SharePoint lookup ("value;#id…")? */
export const isLookupCell = (text) => String(text ?? '').includes(LOOKUP_SEPARATOR);

/**
 * The values of a lookup cell. A well-formed one alternates value and id
 * ("v;#1;#w;#2", or id first: "1;#v;#2;#w"); take the value positions. Anything
 * else: every token that is not only digits.
 */
export function lookupTokens(text) {
  const tokens = String(text ?? '').split(LOOKUP_SEPARATOR).map(s => s.trim());
  const at = (parity) => tokens.filter((_, i) => i % 2 === parity);
  const odd = at(1);
  const even = at(0);
  if (odd.length > 0 && odd.every(isDigits)) return even.filter(Boolean);
  if (odd.length > 0 && even.every(isDigits)) return odd.filter(Boolean);
  return tokens.filter(t => t && !isDigits(t));
}

const CLAIM = /^i:0[#][.]\w\|/i;
const ANGLE_MAIL = /<\s*([^<>\s@]+@[^<>\s@]+)\s*>\s*$/;

/** One value: the address of a claim or of "Name <address>", else the trimmed text. */
export function cleanValue(token) {
  const text = String(token ?? '').trim();
  if (CLAIM.test(text)) return text.slice(text.lastIndexOf('|') + 1).trim();
  const mail = ANGLE_MAIL.exec(text);
  return mail ? mail[1] : text;
}

/**
 * The items of one cell, cleaned, blanks dropped. A lookup cell splits on ";#";
 * otherwise on `;` or a line break, and only a cell with neither on `,` — so
 * "Doe, John; Roe, Jane" stays two names, while "a@x.nl, b@x.nl" is two addresses.
 */
export function splitValues(cell) {
  const text = String(cell ?? '');
  let raw;
  if (isLookupCell(text)) raw = lookupTokens(text);
  else if (/[;\r\n]/.test(text)) raw = parts(text, /[;\r\n]+/);
  else raw = parts(text, /,/);
  return raw.map(cleanValue).filter(Boolean);
}

/** The one value of a cell: the first of a lookup, never split on a comma ("Doe, John" is one owner). */
export function singleValue(cell) {
  const text = String(cell ?? '').trim();
  return cleanValue(isLookupCell(text) ? (lookupTokens(text)[0] ?? '') : text);
}
