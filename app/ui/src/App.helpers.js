// Pure helpers extracted from App.jsx so the app shell stays a thin composition
// layer and the URL / detail-tab logic can be unit-tested in isolation.

// Hash prefixes that address a dynamic detail tab (#user:id, #group:id, …)
// rather than a static page route.
export const DETAIL_PREFIXES = [
  'user', 'group', 'resource', 'access-package',
  'department', 'context', 'identity', 'run', 'report', 'report-builder', 'context-builder',
  'bot-answer',
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

// Hash prefix that opens a shared matrix (#1166). The address rides in the URL
// FRAGMENT, which browsers never send to a server, so it can't land in a proxy
// or access log the way a query parameter would.
export const SHARED_PREFIX = 'shared:';

// The URL a share recipient opens. `address` is the share's id for links minted
// since #1202 — which is what makes a link copyable again later — or a legacy
// `fgs_…` token; the resolve endpoint accepts both, and neither is a credential
// on its own (the recipient signs in, and only named people are let through).
export function buildShareUrl(address) {
  return `${window.location.origin}${window.location.pathname}#${SHARED_PREFIX}${address}`;
}

// The share address in a "#shared:<address>" hash, or null for any other route.
// Whitespace-only or empty addresses are treated as "not a share route" so the
// normal app shell still renders rather than a broken shared view.
export function parseSharedRoute(page) {
  if (typeof page !== 'string' || !page.startsWith(SHARED_PREFIX)) return null;
  const token = page.slice(SHARED_PREFIX.length).trim();
  return token || null;
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
  report: 'reports',
  'bot-answer': 'reports',
  'report-builder': 'reports',
  department: 'contexts',
  context: 'contexts',
  'context-builder': 'contexts',
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
  'context-builder': 'bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300',
  report: 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300',
  'bot-answer': 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300',
  'report-builder': 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300',
};
const DETAIL_TAB_ICON_BG_DEFAULT =
  'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300';
export function detailTabIconBg(type) {
  return DETAIL_TAB_ICON_BG[type] || DETAIL_TAB_ICON_BG_DEFAULT;
}

// How the matrix wizard opens (#1202): on which step, and whether as a fresh,
// empty matrix instead of the one on screen. Anything else passed in — such as
// the click event of an onClick wired straight to the opener — opens it the
// usual way: the matrix on screen, first step.
export function wizardOpening(options) {
  return {
    step: typeof options?.step === 'string' ? options.step : null,
    fresh: options?.fresh === true,
  };
}
