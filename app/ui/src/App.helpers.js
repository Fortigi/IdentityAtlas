// Pure helpers extracted from App.jsx so the app shell stays a thin composition
// layer and the URL / detail-tab logic can be unit-tested in isolation.

// Hash prefixes that address a dynamic detail tab (#user:id, #group:id, …)
// rather than a static page route.
export const DETAIL_PREFIXES = [
  'user', 'group', 'resource', 'access-package',
  'department', 'context', 'identity', 'run',
];

// True when a hash page-key addresses a detail tab.
export function isDetailPage(page) {
  return DETAIL_PREFIXES.some(prefix => page.startsWith(prefix + ':'));
}

// Split a detail hash "type:id" into its parts (the first colon separates the
// two; ids may themselves contain colons). Returns null for non-detail pages.
export function parseDetailRoute(page) {
  if (!isDetailPage(page)) return null;
  const sepIdx = page.indexOf(':');
  return { type: page.substring(0, sepIdx), id: page.substring(sepIdx + 1) };
}

// The display name embedded in a detail page's cached payload, across the
// several shapes the detail pages emit. Used to relabel a tab that was opened
// by direct URL (which only had the UUID as a placeholder).
export function pickDisplayName(partialData) {
  return (
    partialData?.identity?.displayName ||          // identity detail
    partialData?.core?.attributes?.displayName ||  // group / resource
    partialData?.core?.displayName ||              // user detail
    partialData?.attributes?.displayName ||        // direct attributes
    partialData?.displayName ||                    // flat shape
    null
  );
}

// Fallback page to land on when the active detail tab is closed and it carried
// no explicit returnPage.
const CLOSE_FALLBACK = {
  run: 'contexts',
  department: 'contexts',
  context: 'contexts',
  identity: 'identities',
  resource: 'resources',
};
export function closeFallbackPage(type) {
  return CLOSE_FALLBACK[type] || 'matrix';
}

// Tailwind badge-background classes for a detail tab's type glyph.
const DETAIL_TAB_ICON_BG = {
  user: 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300',
  resource: 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300',
  group: 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300',
  department: 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300',
  context: 'bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300',
};
const DETAIL_TAB_ICON_BG_DEFAULT =
  'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300';
export function detailTabIconBg(type) {
  return DETAIL_TAB_ICON_BG[type] || DETAIL_TAB_ICON_BG_DEFAULT;
}
