import { formatDate } from '@ui/utils/formatters';

// Pure helpers shared by the Organisation panels and the org-entity detail page.
//
// Kept apart from the .jsx files so the panels export only components and this
// logic is mutated (stryker.orgtruth.config.json).
//
// Assumptions about the API shapes (verify at integration, T7):
//   - a list route answers either a bare array or `{ data: [...], total }`;
//     `rowsOf` / `totalOf` accept both;
//   - `signals` on a link is the stored CSV ("email,name") or already an array;
//   - list paging is 1-based on the wire (`?page=1` is the first page) while the
//     shared Pagination component is 0-based; `pageParam` converts.

// useFetch rejects a non-ok response with Error(`HTTP <status>`). A 501 is the
// composed router saying "this route is not built yet" (routes/orgTruth.js).
export function isNotAvailable(error) {
  return error?.message === 'HTTP 501';
}

// True while a useFetch result has nothing to show yet: it failed, or it is
// still loading its first response (a reload keeps the old data on screen).
export function fetchBlocked(state) {
  return Boolean(state?.error) || Boolean(state?.loading && state?.data == null);
}

export function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

export function totalOf(data) {
  if (typeof data?.total === 'number') return data.total;
  return rowsOf(data).length;
}

export function pageParam(zeroBasedPage) {
  return String(zeroBasedPage + 1);
}

// Query string from an object, dropping empty values (so `?type=` never reaches
// the API as an empty filter). Returns '' or '?a=b&c=d'.
export function buildQuery(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    qs.set(k, v === true ? '1' : String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export function splitSignals(signals) {
  if (Array.isArray(signals)) return signals.filter(Boolean);
  if (typeof signals !== 'string') return [];
  return signals.split(',').map(s => s.trim()).filter(Boolean);
}

// Status pill colour family per status (claims, links and runs share it).
const STATUS_COLOR = {
  accepted: 'green',
  completed: 'green',
  confirmed: 'green',
  proposed: 'amber',
  queued: 'amber',
  running: 'blue',
  moved: 'blue',
  rejected: 'red',
  failed: 'red',
  closed: 'gray',
};

const PILL_CLASSES = {
  green: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300',
  amber: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  blue: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
  red: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300',
  gray: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

export function statusPillClass(status) {
  return PILL_CLASSES[STATUS_COLOR[status] || 'gray'];
}

// The detail-tab kind a link's target opens (the hash prefixes of DetailRoute).
const TARGET_DETAIL_KIND = {
  Principal: 'user',
  Resource: 'resource',
  Identity: 'identity',
  Context: 'context',
};

export function targetDetailKind(targetType) {
  return TARGET_DETAIL_KIND[targetType] || null;
}

// User-facing word per system target type.
const TARGET_LABEL = {
  Principal: 'Account',
  Resource: 'Resource',
  Identity: 'Identity',
  Context: 'Context',
};

export function targetTypeLabel(targetType) {
  return TARGET_LABEL[targetType] || targetType || '';
}

// One-line summary of a run's stats (entities / relations / links), tolerant
// of a run that has not written stats yet.
export function runStatsSummary(stats) {
  if (!stats) return '';
  const sum = (obj) => Object.values(obj || {}).reduce((n, v) => n + (Number(v) || 0), 0);
  const parts = [];
  const entities = sum(stats.entities?.byType);
  const relations = sum(stats.relations?.byPredicate);
  if (entities > 0) parts.push(`${entities} entities`);
  if (relations > 0) parts.push(`${relations} relations`);
  const links = stats.links || {};
  const linked = Number(links.linked ?? links.accepted) || 0;
  const proposed = Number(links.proposed) || 0;
  if (linked > 0 || proposed > 0) parts.push(`${linked} linked · ${proposed} proposed`);
  return parts.join(' · ');
}

// Runs of one source, newest first, and the profile of the most recent run that
// has one (what "Import again" re-uses).
export function runsForSource(runs, sourceId) {
  return (runs || [])
    .filter(r => r.sourceId === sourceId)
    .sort((a, b) => String(b.createdAt || b.startedAt || '').localeCompare(String(a.createdAt || a.startedAt || '')));
}

export function lastProfileId(sourceRuns) {
  return (sourceRuns || []).find(r => r.profileId)?.profileId || null;
}

// Rows for the detail page's AttributesTable: core fields first, then the imported attributes (marked as extended).
export function attributeEntries(entity) {
  const core = [
    ['canonicalKey', entity.canonicalKey],
    ['origin', entity.origin],
    ['confidence', entity.confidence],
    ['validFrom', formatDate(entity.validFrom)],
    ['validTo', formatDate(entity.validTo)],
  ];
  const extra = Object.entries(entity.attributes || {}).map(([k, v]) => [k, v, { extended: true }]);
  return [...core, ...extra];
}
