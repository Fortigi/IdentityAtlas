// Which `extendedAttributes` keys the app can name in SQL, and how.
//
// A key a source sends is the source's own word: "CMDB Reference", "Cost-Center",
// "Kostenplaats (NL)". Filters, the matrix and the report builder put that key
// into SQL text (`"extendedAttributes"->>'<key>'`) and the report builder also
// into a column alias (`AS "ext.<key>"`). They used to accept only
// [A-Za-z0-9_], which made that interpolation trivially safe — and silently
// dropped every key with a space or a dash, so a CMDB reference could be stored
// and shown but never filtered or reported on.
//
// What can actually break out of those two contexts is a quote of either kind,
// a backslash, or a control character. Those are refused; everything else is
// accepted, up to 128 characters. extKeyLiteral() still doubles any single
// quote, so a key that somehow skipped isExtKey() cannot end the literal.
//
// discoverExtendedAttrKeys (db/columnCache.js) applies the same rule in SQL,
// as EXT_KEY_SQL_RE, so a refused key never uses up the 300-key budget.

export const EXT_PREFIX = 'ext.';
export const MAX_EXT_KEY_LENGTH = 128;

export const EXT_KEY_RE = new RegExp(`^[^'"\\\\\\p{Cc}]{1,${MAX_EXT_KEY_LENGTH}}$`, 'u');

// The same rule as a PostgreSQL regular expression, for use inside a
// single-quoted SQL literal (the '' is the doubled quote of that literal).
export const EXT_KEY_SQL_RE = `^[^''"\\\\[:cntrl:]]{1,${MAX_EXT_KEY_LENGTH}}$`;

export function isExtKey(key) {
  return typeof key === 'string' && EXT_KEY_RE.test(key);
}

// The key as a SQL string literal. Throws on a key isExtKey() refuses: every
// caller checks first, so reaching this with a bad key is a bug, not input.
export function extKeyLiteral(key) {
  if (!isExtKey(key)) throw new Error('invalid extendedAttributes key');
  return `'${key.replace(/'/g, "''")}'`;
}

// `<alias>."extendedAttributes"->>'<key>'` — the text value of one key.
// Without an alias the column is unqualified.
export function extValueSql(key, alias = '') {
  return `${alias ? `${alias}.` : ''}"extendedAttributes"->>${extKeyLiteral(key)}`;
}

// The key of an `ext.<key>` field name, or null when it isn't one or the key
// is refused.
export function extKeyOf(field) {
  if (typeof field !== 'string' || !field.startsWith(EXT_PREFIX)) return null;
  const key = field.slice(EXT_PREFIX.length);
  return isExtKey(key) ? key : null;
}
