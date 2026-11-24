// How a business role is gained and lost, in the words and colours of the UI.
// The values come from the API (ontology: ia:AccessWayIn, ia:AccessWayOut); a
// role can have several of each.

const GREEN = 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700';
const BLUE = 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700';
const PURPLE = 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700';
const AMBER = 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700';
const TEAL = 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-700';
const ORANGE = 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700';
const GRAY = 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600';

export const WAYS = {
  in: {
    Rule: { label: 'Rule', hint: 'A rule hands this role to everyone who matches it', style: GREEN },
    Request: { label: 'Request', hint: 'People can request this role', style: BLUE },
    Assigned: { label: 'Assigned', hint: 'An administrator assigns this role', style: PURPLE },
    Unknown: { label: 'Unknown', hint: 'The source does not say how this role is gained', style: GRAY },
  },
  out: {
    Rule: { label: 'Removal rule', hint: 'Removed when someone no longer matches the rule', style: AMBER },
    Review: { label: 'Review', hint: 'An access review can remove this role', style: TEAL },
    Expiry: { label: 'Expiry', hint: 'An assignment ends by itself', style: ORANGE },
    Manual: { label: 'Removal request', hint: 'Someone can request its removal', style: GRAY },
    Unknown: { label: 'Unknown', hint: 'The source does not say how this role is lost', style: GRAY },
  },
};

export const ACCESS_FILTERS = [
  { label: 'Gained by', direction: 'in', ways: ['Rule', 'Request', 'Assigned', 'Unknown'] },
  { label: 'Lost by', direction: 'out', ways: ['Rule', 'Review', 'Expiry', 'Manual', 'Unknown'] },
];

// A filter value is "in:Rule" or "out:Review". A role matches when it has that
// way among its others.
export function matchesAccessFilter(role, filter) {
  if (!filter) return true;
  const [direction, way] = filter.split(':');
  const ways = direction === 'in' ? role.accessModel?.waysIn : role.accessModel?.waysOut;
  return (ways ?? ['Unknown']).includes(way);
}

// "P365D" → 365 days, "P2W" → 14 days, "P3M" → 3 months, "P1Y" → 1 year.
export function formatDuration(iso) {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(iso || '');
  if (!m) return null;
  const days = Number(m[3] || 0) * 7 + Number(m[4] || 0);
  const parts = [[m[1], 'year'], [m[2], 'month'], [days || null, 'day']]
    .filter(([n]) => Number(n) > 0)
    .map(([n, unit]) => `${Number(n)} ${unit}${Number(n) === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

export function describeExpiry(expiration, formatDate) {
  if (expiration?.type === 'afterDuration') {
    const span = formatDuration(expiration.duration);
    return span ? `Ends after ${span}` : 'Ends after a set time';
  }
  if (expiration?.type === 'afterDateTime') {
    return expiration.endDateTime ? `Ends on ${formatDate(expiration.endDateTime)}` : 'Ends on a set date';
  }
  return null;
}

// Human-readable review cadence from a policy's reviewSettings.
export function describeCadence(rs) {
  if (!rs) return null;
  if (rs.isEnabled === false) return 'Access review: disabled';
  const pat = rs.schedule?.recurrence?.pattern;
  const unit = { absoluteMonthly: 'month', relativeMonthly: 'month', weekly: 'week', daily: 'day', absoluteYearly: 'year' }[pat?.type];
  let cad = 'one-time';
  if (pat?.interval && unit) cad = pat.interval === 1 ? `every ${unit}` : `every ${pat.interval} ${unit}s`;
  const durMatch = /P(\d+)D/.exec(rs.schedule?.expiration?.duration || '');
  const window = durMatch ? `, ${durMatch[1]}-day window` : '';
  return `Access review: recurs ${cad}${window}`;
}

// The People tab: paged in the browser, so the list is never cut off.
export const MEMBER_PAGE_SIZE = 100;

// A person who got the role two ways counts under each.
export function countByWay(rows) {
  const counts = {};
  for (const row of rows) {
    for (const way of row.howHeld ?? ['Unknown']) counts[way] = (counts[way] ?? 0) + 1;
  }
  return counts;
}

export function filterMembers(rows, search, way) {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (way && !(r.howHeld ?? ['Unknown']).includes(way)) return false;
    if (!q) return true;
    return `${r.targetDisplayName ?? ''} ${r.targetUPN ?? ''}`.toLowerCase().includes(q);
  });
}

// What the text of a policy's rule does here.
export function ruleLabel(policy) {
  if (policy.hasAutoAddRule && policy.hasAutoRemoveRule) return 'Added and removed by this rule';
  if (policy.hasAutoAddRule) return 'Added by this rule';
  if (policy.hasAutoRemoveRule) return 'Removed when someone stops matching';
  return 'Who may request it';
}

export function approvalText(policy) {
  if (!policy.allowsRequest) return null;
  if (policy.requiresApproval === true) return 'Requests need approval';
  if (policy.requiresApproval === false) return 'Requests are granted without approval';
  return null;
}

export function removalText(policy) {
  if (policy.hasAutoRemoveRule && !policy.targetRule) return 'Removed when someone leaves the people this policy allows';
  return null;
}

// Requests & reviews matter for a role that can be requested or reviewed, or
// that has either on record whatever its policies say now.
export function showsRequestsAndReviews(data) {
  const { waysIn = [], waysOut = [] } = data.accessModel ?? {};
  return waysIn.includes('Request') || waysOut.includes('Review') || data.reviewCount > 0 || data.pendingRequestCount > 0;
}
