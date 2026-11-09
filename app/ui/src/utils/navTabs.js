// Top-nav tab definitions + visibility rules. Kept out of App.jsx so the
// filtering can be unit-tested without rendering the whole app.
//
// Tab flags:
//   feature   — only shown when that feature flag is enabled server-side.
//               An admin turning on an off-by-default feature (Risk Scores) is
//               the opt-in, so its tab surfaces automatically (audit H-13).
//   optional  — hidden by default; the user opts in via Settings → tabs, which
//               adds the tab key to their `visibleTabs` preference.
//
// Both flags may be combined: the tab then needs the feature on AND the user's
// opt-in, and the Settings switch is only offered while the feature is on.
// Identities is the one such tab — account linking is on by default, so the
// flag alone would put it in front of everyone.
//
// Systems, Identities, Contexts and Sync Log are optional: not every deployment
// links accounts or builds contexts, and the admin-leaning views are clutter for
// most users. Reports is a default tab — everyone consumes reports.

export const ALL_NAV_TABS = [
  { key: 'dashboard',        label: 'Dashboard' },
  { key: 'matrix',           label: 'Matrix' },
  { key: 'principals',       label: 'Principals (Users)' },
  { key: 'resources',        label: 'Resources' },
  { key: 'systems',          label: 'Systems',      optional: true },
  { key: 'access-packages',  label: 'Business Roles' },
  { key: 'risk-scores',      label: 'Risk Scores',  feature: 'riskScoring' },
  { key: 'identities',       label: 'Identities',   feature: 'accountLinking', optional: true },
  { key: 'contexts',         label: 'Contexts',     optional: true },
  { key: 'reports',          label: 'Reports' },
  { key: 'sync-log',         label: 'Logs',         optional: true },
  { key: 'admin',            label: 'Admin' },
];

// Tabs to render in the nav bar.
//   - feature-gated tabs drop out when their flag is off
//   - optional tabs drop out unless the user has enabled them (once preferences
//     have loaded; while `visibleTabs` is null we don't hide them, to avoid a
//     flash of removal before prefs arrive)
//   - Admin drops out for users without admin permission
//
// Shared matrices is deliberately NOT here: managing and revoking other
// people's share links is administration, so it lives as an Admin sub-tab
// (see components/admin/adminTabs.js) rather than as a twelfth top-level tab.
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
