// Top-nav tab definitions + visibility rules. Kept out of App.jsx so the
// filtering can be unit-tested without rendering the whole app.
//
// Tab flags:
//   feature   — only shown when that feature flag is enabled server-side.
//               Enabling the feature (an admin action) IS the opt-in, so the tab
//               surfaces automatically when it's on — it is NOT also `optional`
//               (audit H-13: Risk Scores / Identities used to stay hidden behind
//               a second per-user toggle even after the feature was turned on).
//   optional  — hidden by default; the user opts in via Settings → tabs, which
//               adds the tab key to their `visibleTabs` preference. Reserved for
//               always-available views that just declutter the nav (never combine
//               with `feature`).
//
// Systems and Sync Log are optional: most users live in the Matrix / Principals /
// Contexts surfaces, so these admin-leaning views are off by default and can be
// switched on per-user when needed.

export const ALL_NAV_TABS = [
  { key: 'dashboard',        label: 'Dashboard' },
  { key: 'matrix',           label: 'Matrix' },
  { key: 'principals',       label: 'Principals (Users)' },
  { key: 'resources',        label: 'Resources' },
  { key: 'systems',          label: 'Systems',      optional: true },
  { key: 'access-packages',  label: 'Business Roles' },
  { key: 'risk-scores',      label: 'Risk Scores',  feature: 'riskScoring' },
  { key: 'identities',       label: 'Identities',   feature: 'accountLinking' },
  { key: 'contexts',         label: 'Contexts' },
  { key: 'sync-log',         label: 'Logs',         optional: true },
  { key: 'admin',            label: 'Admin' },
];

// Tabs to render in the nav bar.
//   - feature-gated tabs drop out when their flag is off
//   - optional tabs drop out unless the user has enabled them (once preferences
//     have loaded; while `visibleTabs` is null we don't hide them, to avoid a
//     flash of removal before prefs arrive)
//   - Admin drops out for users without admin permission
export function computeNavTabs({ features = {}, visibleTabs = null, canSeeAdmin = true } = {}) {
  return ALL_NAV_TABS.filter(tab => {
    if (tab.feature && !features[tab.feature]) return false;
    if (tab.optional && visibleTabs && !visibleTabs.includes(tab.key)) return false;
    if (tab.key === 'admin' && !canSeeAdmin) return false;
    return true;
  });
}

// Optional tabs the user is allowed to toggle on/off (respecting feature flags).
export function availableOptionalTabs(features = {}) {
  return ALL_NAV_TABS.filter(tab => tab.optional && (!tab.feature || features[tab.feature]));
}
