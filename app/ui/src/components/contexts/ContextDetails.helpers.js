// Pure helpers for ContextDetails.jsx, kept out of the component file so React
// Fast Refresh can hot-swap it (react-refresh/only-export-components).
//
// The context page shows every attribute once. The header carries the name,
// owner, parents, the subtitle sentence (type and source) and the access
// counts; the description has its own card; a templated context's profile
// carries the member counts. What is left goes into the "More details" list
// this builds.
//
// Two readers (`analyst`): someone who can edit contexts also gets the raw
// classification behind the subtitle (variant, target type, context type, …)
// and the bookkeeping flags; a business reader gets neither.

import { buildAttributeEntries } from '@ui/utils/attributeEntries';
import { friendlyLabel } from '@ui/utils/formatters';
import { accessCountParts } from './ContextAccessCounts.helpers';

// Shown elsewhere on the page, or internal (temporal columns, ids that only
// point at something already shown by name).
const SHOWN_ELSEWHERE = [
  'SysStartTime', 'SysEndTime', 'ValidFrom', 'ValidTo',
  'id', 'displayName', 'description',
  'parentContextId', 'parentDisplayName', 'scopeSystemId',
  'sourceAlgorithmId', 'sourceAlgorithmDisplayName', 'sourceRunId',
  'ownerUserId', 'ownerPrincipalId', 'ownerDisplayName',
  'extendedAttributes',
];

// The raw classification the subtitle sentence is built from: the analyst
// sees it here as stored, a business reader only the sentence.
const CLASSIFICATION = ['variant', 'targetType', 'contextType', 'contextCategory', 'scopeSystemName', 'sourceAlgorithmName'];

// Bookkeeping that means nothing to a business reader.
const ANALYST_ONLY = ['userRenamed', 'userReparented', 'directMemberCount', 'createdByUser'];

const ACCESS_COUNT_KEYS = ['resourceCount', 'directAssignmentCount', 'indirectAssignmentCount', 'eligibleAssignmentCount', 'holderCount'];

// Labels that read better than the split column name.
const DETAIL_LABELS = { lastCalculatedAt: 'Last updated' };

export function detailLabel(key) {
  return DETAIL_LABELS[key] || friendlyLabel(key);
}

/**
 * The keys the details list leaves out for this context: the fixed set above,
 * plus what this particular page happens to show elsewhere — the access
 * counts once the header prints them and the member counts the profile prints
 * — and, for a business reader, the classification and bookkeeping.
 */
export function hiddenDetailKeys(attrs, { hasProfile = false, analyst = false } = {}) {
  const hidden = new Set(SHOWN_ELSEWHERE);
  if (!analyst) [...CLASSIFICATION, ...ANALYST_ONLY].forEach(k => hidden.add(k));
  if (accessCountParts(attrs).length > 0) ACCESS_COUNT_KEYS.forEach(k => hidden.add(k));
  if (hasProfile) ['totalMemberCount', 'directMemberCount'].forEach(k => hidden.add(k));
  return hidden;
}

/** [key, value, meta?] rows for the details list — core attributes, then extendedAttributes. */
export function detailEntries(attrs, opts) {
  if (!attrs) return [];
  const ext = attrs.extendedAttributes && typeof attrs.extendedAttributes === 'object' ? attrs.extendedAttributes : null;
  return buildAttributeEntries(attrs, ext, hiddenDetailKeys(attrs, opts));
}
