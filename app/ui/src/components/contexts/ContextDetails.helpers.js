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
import { friendlyLabel, formatDate } from '@ui/utils/formatters';
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
const CLASSIFICATION = ['variant', 'targetType', 'contextType', 'contextCategory', 'scopeSystemName', 'scopeSystemType', 'sourceAlgorithmName'];

// Bookkeeping that means nothing to a business reader.
const ANALYST_ONLY = ['userRenamed', 'userReparented', 'directMemberCount', 'createdByUser'];

const ACCESS_COUNT_KEYS = ['resourceCount', 'directAssignmentCount', 'indirectAssignmentCount', 'eligibleAssignmentCount', 'holderCount'];

// Labels that read better than the split column name.
const DETAIL_LABELS = {
  lastCalculatedAt: 'Last updated',
  // A context of an uploaded list (GET /api/contexts/:id adds these).
  uploadedFrom: 'Uploaded from',
  uploadedAt: 'Uploaded on',
  uploadedBy: 'Uploaded by',
  lastUploadFile: 'Last upload',
  lastUploadAt: 'Last upload on',
  lastUploadBy: 'Last upload by',
};

export function detailLabel(key) {
  return DETAIL_LABELS[key] || friendlyLabel(key);
}

// Extended attributes keep their own names, except the ones the app itself
// writes: `aliases` (other names of the context — a confirmed interview alias
// claim adds to it) reads as "Also known as", its names as one line.
const EXTENDED_LABELS = { aliases: 'Also known as' };

export function extendedLabel(key) {
  return EXTENDED_LABELS[key] || key;
}

/** A value as the details list shows it: a list of names as "A, B"; anything else as given. */
export function detailValue(value) {
  return Array.isArray(value) && value.every(v => typeof v === 'string') ? value.join(', ') : value;
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

// Extended attributes a templated context's profile shows itself: the aliases
// are its "Also known as" fact (interviews/AlsoKnownAs.jsx), with the proposed ones.
const PROFILE_EXTENDED = ['aliases'];

/** [key, value, meta?] rows for the details list — core attributes, then extendedAttributes. */
export function detailEntries(attrs, opts) {
  if (!attrs) return [];
  let ext = attrs.extendedAttributes && typeof attrs.extendedAttributes === 'object' ? attrs.extendedAttributes : null;
  if (ext && opts?.hasProfile) ext = Object.fromEntries(Object.entries(ext).filter(([k]) => !PROFILE_EXTENDED.includes(k)));
  return buildAttributeEntries(attrs, ext, hiddenDetailKeys(attrs, opts));
}

// Where a context of an uploaded list came from, as the one line under its
// header (UploadProvenance.jsx): "Uploaded from klanten.xlsx on 3 Oct 2026 by …;
// last updated by an upload of klanten-v2.xlsx on 20 Oct 2026. This unit exists
// since 3 Oct 2026." Null for any other context.
export function provenanceText(attrs) {
  if (!attrs?.uploadedFrom) return null;
  const by = attrs.uploadedBy && attrs.uploadedBy !== 'unknown' ? ` by ${attrs.uploadedBy}` : '';
  const updated = attrs.lastUploadAt && attrs.lastUploadAt !== attrs.uploadedAt
    ? `; last updated by an upload of ${attrs.lastUploadFile} on ${formatDate(attrs.lastUploadAt)}`
    : '';
  const since = attrs.createdAt ? ` This unit exists since ${formatDate(attrs.createdAt)}.` : '';
  return `Uploaded from ${attrs.uploadedFrom} on ${formatDate(attrs.uploadedAt)}${by}${updated}.${since}`;
}
