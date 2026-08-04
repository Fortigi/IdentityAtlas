// Pure helpers for ordering the matrix subject (column) axis by 1–3 attributes
// and computing the merged-header spans those attributes produce. Extracted from
// MatrixView / MatrixColumnHeaders so the logic is unit-testable.
//
// Each subject carries a precomputed `sortKeys` array — the attribute values in
// sort-attribute order. We never write to a property whose NAME comes from the
// user's filter (that would be a prototype-pollution sink); the user-derived
// attribute name is only ever READ, in buildSortKeys, to populate the static
// `sortKeys` array.

import { DEFAULT_SORT } from '@ui/utils/matrixFilter';

const collate = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Read the (attribute → string) values for one row, in sort-attribute order.
// An `ext.<key>` attribute reads from the row's extendedAttributes JSON; a plain
// name reads the real column. These are dynamic READS (safe — only dynamic
// *writes* are property-injection sinks).
export function buildSortKeys(row, sortAttributes) {
  const attrs = (Array.isArray(sortAttributes) && sortAttributes.length) ? sortAttributes : DEFAULT_SORT;
  return attrs.map(sa => {
    const a = sa.attribute;
    let v;
    if (typeof a === 'string' && a.startsWith('ext.')) v = row && row.extendedAttributes ? row.extendedAttributes[a.slice(4)] : undefined;
    else v = row == null ? '' : row[a];
    return v == null ? '' : String(v);
  });
}

// Comparator over the precomputed sortKeys arrays. Empty values sort to the END
// regardless of direction; ties break on displayName.
export function makeUserComparator(sortAttributes) {
  const dirs = ((Array.isArray(sortAttributes) && sortAttributes.length) ? sortAttributes : DEFAULT_SORT)
    .map(s => (s.dir === 'desc' ? -1 : 1));
  return (a, b) => {
    const ak = a.sortKeys || [];
    const bk = b.sortKeys || [];
    for (let i = 0; i < dirs.length; i++) {
      const av = ak[i] ?? '';
      const bv = bk[i] ?? '';
      if (av !== bv) {
        if (av === '') return 1;
        if (bv === '') return -1;
        const cmp = collate(av, bv);
        if (cmp !== 0) return cmp * dirs[i];
      }
    }
    return collate(String(a.displayName || ''), String(b.displayName || ''));
  };
}

// Run-length spans of equal values at sortKeys[index] over an ALREADY-SORTED
// users array, used to render merged header cells. Returns [{ value, start, span }].
export function computeAttributeSpans(users, index) {
  const at = (u) => (u && u.sortKeys ? (u.sortKeys[index] ?? '') : '');
  const spans = [];
  let i = 0;
  while (i < users.length) {
    const v = at(users[i]);
    let j = i + 1;
    while (j < users.length && at(users[j]) === v) j++;
    spans.push({ value: v, start: i, span: j - i });
    i = j;
  }
  return spans;
}
