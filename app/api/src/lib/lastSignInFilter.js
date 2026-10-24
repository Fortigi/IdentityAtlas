// The virtual `__lastSignIn` filter column on the Principals list page.
//
// Same shape as the `__system` / `__userTag` virtual columns (see
// lib/systemFilter.js): one helper adds it to a discovery response, one pulls
// the key out of a parsed filters object, one renders the WHERE fragment.
//
// The values are AGE BUCKETS, not dates. The list's filter machinery matches a
// column against one of a fixed set of offered values, so buckets fit it
// exactly and need no new operator model — and "accounts idle for more than 90
// days" is the question a list view is actually asked. A precise
// "before <date>" threshold is what the activity reports are for, with the
// measurement moment stated alongside it.
//
// Why "now" and not the measurement moment: this is a browsing filter over a
// column whose value is displayed right next to it, so the user can see the
// staleness for themselves. The reports, which assert staleness as a finding,
// anchor to the measurement moment instead (reports/activityWindow.js).

export const LAST_SIGN_IN_FILTER_KEY = '__lastSignIn';

/** The bucket label → the number of days it means; `null` means "no sign-in at all". */
export const LAST_SIGN_IN_BUCKETS = {
  'Never': null,
  'Over 30 days ago': 30,
  'Over 90 days ago': 90,
  'Over 180 days ago': 180,
};

/** The offered values, in increasing-staleness order. */
export const LAST_SIGN_IN_BUCKET_NAMES = Object.keys(LAST_SIGN_IN_BUCKETS);

/** Add the virtual column to a `{ column: values }` discovery map (mutates it). */
export function addLastSignInColumn(grouped, { schemaOnly = false } = {}) {
  grouped[LAST_SIGN_IN_FILTER_KEY] = schemaOnly ? [] : [...LAST_SIGN_IN_BUCKET_NAMES];
  return grouped;
}

/**
 * Pull `__lastSignIn` out of a parsed filters object (mutating it) so it isn't
 * validated as a real column. Returns the selected bucket name, or null when
 * absent, blank, or not one we offer — an unknown bucket filters nothing rather
 * than erroring, matching how the other virtual columns treat bad input.
 */
export function extractLastSignInFilter(attrFilters) {
  if (!attrFilters || attrFilters[LAST_SIGN_IN_FILTER_KEY] == null) return null;
  const bucket = String(attrFilters[LAST_SIGN_IN_FILTER_KEY]).trim();
  delete attrFilters[LAST_SIGN_IN_FILTER_KEY];
  return Object.hasOwn(LAST_SIGN_IN_BUCKETS, bucket) ? bucket : null;
}

/**
 * The WHERE fragment for a bucket, over the activity lateral's output alias.
 *
 * `Never` is "no aggregate timestamp at all", which covers both a principal
 * with no activity row and one whose row has every timestamp null — the two are
 * the same fact to a reader.
 *
 * @param {string|null} bucket     from extractLastSignInFilter
 * @param {string} alias           alias of the activity lateral (its `"lastSignIn"`)
 * @param {(v: unknown) => string} bind
 */
export function lastSignInFilterWhere(bucket, alias, bind) {
  if (!bucket) return '';
  const days = LAST_SIGN_IN_BUCKETS[bucket];
  if (days === null) return ` AND ${alias}."lastSignIn" IS NULL`;
  return ` AND ${alias}."lastSignIn" < now() - make_interval(days => ${bind(days)})`;
}
