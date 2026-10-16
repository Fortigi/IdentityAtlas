// The "matched on" line of an extended search result. The API names each field
// a search term was found in (lib/entitySearch.js in the API): a column
// ("employeeId"), a dotted path into extendedAttributes
// ("employeeOrgData.costCenter"), a key as the source wrote it ("CMDB
// Reference"), or "linkedAccount" for an identity found through one of its
// accounts.

// The API falls back to normal search below this many characters, so the UI
// only promises an extended search (and a "matched on" column) from here on.
export const MIN_EXTENDED_SEARCH_LENGTH = 3;

const SPECIAL = { linkedAccount: 'a linked account' };

// "mobilePhone" → "Mobile phone"; a key that already has spaces or capitals
// in a row ("CMDB Reference", "SAP_ID") is left as the source wrote it.
export function humanizeField(key) {
  if (/[\s_]/.test(key) || /[A-Z]{2}/.test(key)) return key;
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// One field: a page-supplied label wins, then the special names, then the
// humanised key; a dotted path reads "Employee org data › Cost center".
export function fieldLabel(field, labels = {}) {
  if (labels[field]) return labels[field];
  if (SPECIAL[field]) return SPECIAL[field];
  return field.split('.').map(humanizeField).join(' › ');
}

// The whole line, or '' when there is nothing to say.
export function formatMatchedOn(fields, labels = {}) {
  if (!Array.isArray(fields) || fields.length === 0) return '';
  return fields.map(f => fieldLabel(f, labels)).join(', ');
}

// Whether a search, as typed, runs as an extended search on the API.
export function isExtendedSearchActive(extended, term) {
  return Boolean(extended) && String(term ?? '').trim().length >= MIN_EXTENDED_SEARCH_LENGTH;
}
