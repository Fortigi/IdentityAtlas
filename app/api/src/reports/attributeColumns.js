// Every attribute the entitlements of a run carry, as extra columns.
//
// What a source stores about an entitlement — how often it is certified,
// whether it can be requested, its risk level — is named differently in every
// deployment, so the review cannot list those columns in code and should not
// make every reader pick them. A run therefore adds a column for each
// extendedAttributes key its own rows carry a value for, after the standard
// columns, sorted by name. A key already shown because it was picked is not
// repeated.
//
// Bounded: at most MAX_ATTRIBUTE_COLUMNS of them. A catalogue with hundreds of
// keys keeps the ones most rows fill, and the run names the rest so they can be
// picked as columns instead. A key that cannot be a field key (a comma, a
// control character — see accessReviewFields.js) is counted with the rest.

import { isOfferableAttributeKey, resolveField } from './accessReviewFields.js';

export const MAX_ATTRIBUTE_COLUMNS = 60;
// How many left-out keys the notice names before it says "and N more".
const NAMED_IN_NOTICE = 20;

const hasValue = v => v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '');

/** Key → number of entitlements that carry a value for it. */
export function attributeKeyCounts(entitlements) {
  const counts = new Map();
  for (const e of entitlements) {
    const attrs = e?.extendedAttributes;
    if (!attrs || typeof attrs !== 'object') continue;
    for (const key of Object.keys(attrs)) {
      if (hasValue(attrs[key])) counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

/**
 * The attribute fields to add to a run whose picked fields are `picked`:
 * `{ fields, omitted }`, where `omitted` names the keys left out by the cap or
 * because they cannot be a field key. A field whose heading would repeat an
 * existing column's is headed "Attribute · <key>" instead, so no two columns —
 * and no two pivot fields — share a name.
 */
export function attributeColumns(entitlements, picked, existingLabels = [], max = MAX_ATTRIBUTE_COLUMNS) {
  const pickedKeys = new Set(picked.map(f => f.key));
  const counts = [...attributeKeyCounts(entitlements)]
    .filter(([key]) => !pickedKeys.has(`entitlement.ext.${key}`));
  const offerable = counts.filter(([key]) => isOfferableAttributeKey(key));
  const kept = [...offerable]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b));
  const keptSet = new Set(kept);
  const omitted = counts.map(([key]) => key).filter(key => !keptSet.has(key)).sort((a, b) => a.localeCompare(b));

  const labels = new Set(existingLabels.map(l => String(l).toLowerCase()));
  const fields = kept.map((key) => {
    const field = resolveField(`entitlement.ext.${key}`);
    const label = labels.has(field.label.toLowerCase()) ? `Attribute · ${key}` : field.label;
    labels.add(label.toLowerCase());
    return { ...field, label };
  });
  return { fields, omitted };
}

/** What the run says about the keys it did not make columns, or nothing. */
export function omittedAttributeNotices(omitted, max = MAX_ATTRIBUTE_COLUMNS) {
  if (!omitted.length) return [];
  const named = omitted.slice(0, NAMED_IN_NOTICE).map(k => `"${k}"`).join(', ');
  const more = omitted.length > NAMED_IN_NOTICE ? ` and ${omitted.length - NAMED_IN_NOTICE} more` : '';
  return [{
    severity: 'info',
    text: `${omitted.length} entitlement attribute(s) are not shown as columns (a run shows at most ${max}, `
      + `the ones most entitlements carry): ${named}${more}. Pick any of them under Columns to include it.`,
  }];
}
