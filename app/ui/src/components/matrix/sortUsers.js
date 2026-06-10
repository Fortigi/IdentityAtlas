// Pure helpers for ordering the matrix subject (column) axis by 1–3 attributes
// and computing the merged-header spans those attributes produce. Extracted from
// MatrixView / MatrixColumnHeaders so the logic is unit-testable.

const DEFAULT_SORT = [{ attribute: 'department', dir: 'asc' }];

function val(obj, attr) {
  const v = obj == null ? '' : obj[attr];
  return v == null ? '' : String(v);
}

const collate = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Build a comparator for the subject objects (users) given the sort attributes.
// Empty attribute values sort to the END regardless of direction (a blank
// department shouldn't lead). Ties break on displayName.
export function makeUserComparator(sortAttributes) {
  const attrs = Array.isArray(sortAttributes) && sortAttributes.length ? sortAttributes : DEFAULT_SORT;
  return (a, b) => {
    for (const { attribute, dir } of attrs) {
      const av = val(a, attribute);
      const bv = val(b, attribute);
      if (av !== bv) {
        if (av === '') return 1;
        if (bv === '') return -1;
        const cmp = collate(av, bv);
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
      }
    }
    return collate(val(a, 'displayName'), val(b, 'displayName'));
  };
}

// Return a new array sorted by the given attributes (does not mutate input).
export function sortUsers(users, sortAttributes) {
  return [...users].sort(makeUserComparator(sortAttributes));
}

// Run-length spans of equal attribute values over an ALREADY-SORTED users array,
// used to render merged header cells. Returns [{ value, start, span }].
export function computeAttributeSpans(users, attribute) {
  const spans = [];
  let i = 0;
  while (i < users.length) {
    const v = val(users[i], attribute);
    let j = i + 1;
    while (j < users.length && val(users[j], attribute) === v) j++;
    spans.push({ value: v, start: i, span: j - i });
    i = j;
  }
  return spans;
}
