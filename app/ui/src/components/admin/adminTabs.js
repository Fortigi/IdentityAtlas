// Admin sub-tab definitions + visibility.
//
// `requires` lists permissions any one of which (logical OR) grants access to
// that sub-tab. Tabs without `requires` are visible to any authenticated user
// (read-only stuff: Performance / About).
//
// NOTE: visibility is permission-driven ONLY. It must NOT depend on the
// deployment platform — Roles & Permissions is its own admin.auth-gated tab so
// hiding it on (e.g.) Azure App Service would lock admins out of managing roles.
// Platform-specific guidance (the Docker CLI walkthrough) is hidden inside
// AuthSettingsPage instead, leaving Roles & Permissions reachable everywhere.
//
// `feature` names an optional-feature flag the tab additionally needs. That is
// not a platform check: a switched-off feature has no page to manage.
//
// `leaveTo` names the tab to land on when this one is hidden, instead of the
// first visible one: a #admin?sub=llm link followed while risk scoring is off
// lands on Experimental, where the switch that brings the tab back lives.

import { hasPermission } from '@ui/auth/usePermissions';

export const ADMIN_TABS = [
  { key: 'crawlers',        label: 'Crawlers',         description: 'Add, configure and run identity data crawlers',                        requires: ['admin.crawlers'] },
  { key: 'plugins',         label: 'Plugins',          description: 'Context plugins: configured trees and ad-hoc runs',                    requires: ['admin.context-plugins'] },
  { key: 'account-linking', label: 'Account Linking',  description: 'Rules for linking orphan accounts to existing identities',             requires: ['admin.crawlers'] },
  { key: 'risk-scoring',    label: 'Risk Scoring',     description: 'Risk profile, classifiers and on-demand scoring runs (experimental)', requires: ['admin.llm', 'admin.crawlers'], feature: 'riskScoring', leaveTo: 'experimental' },
  { key: 'llm',             label: 'Risk Scoring LLM', description: 'The LLM provider risk scoring uses — and nothing else',              requires: ['admin.llm'], feature: 'riskScoring', leaveTo: 'experimental' },
  { key: 'performance',     label: 'Performance',      description: 'API and SQL performance metrics' },

  { key: 'auth',            label: 'Authentication',   description: 'Single sign-on configuration',                                         requires: ['admin.auth'] },
  { key: 'roles',           label: 'Roles & Permissions', description: 'Map identity-provider roles to in-app permissions',                 requires: ['admin.auth'] },
  { key: 'data',            label: 'Data',             description: 'Power Query export, history retention and cleaning the database',      requires: ['data.export.ui', 'admin.systems', 'admin.read-tokens', 'data.export.apikey'] },
  { key: 'shares',          label: 'Shared Matrices',  description: 'Matrices shared by link: who they are for, who opened them, and revoking', requires: ['data.share'], feature: 'matrixSharing' },
  { key: 'experimental',    label: 'Experimental',     description: 'Preview features that are built and tested, but not yet proven in the field',   requires: ['admin.feature-flags'] },
  { key: 'updates',         label: 'Updates',          description: 'Automatic updates and version history',                                requires: ['admin.systems'] },
  { key: 'about',           label: 'About',            description: 'License, version, and software bill of materials' },
];

// Filter the admin sub-tabs to the ones the current user may use. A tab with a
// `feature` also needs that flag on in `features` (/api/features).
export function visibleAdminTabs(permissions, hasWildcard, tabs = ADMIN_TABS, features = {}) {
  return tabs.filter(t =>
    (!t.feature || features[t.feature] === true)
    && (!t.requires || hasPermission(permissions, hasWildcard, ...t.requires)));
}

// Should the page move the user off `activeTab` because they can't see it?
// Not while the tab's feature flag is still unreported: /api/features answers
// after the first render, and a flag it hasn't reported yet is unknown, not
// off. Bouncing on "unknown" sent a `#admin?sub=shares` deep link (and the
// legacy #shared-matrices link) to Crawlers whenever the page won that race.
export function shouldLeaveTab(activeTab, visibleTabs, features = {}) {
  if (!visibleTabs.length || visibleTabs.some(t => t.key === activeTab)) return false;
  const def = ADMIN_TABS.find(t => t.key === activeTab);
  return !(def?.feature && !Object.hasOwn(features || {}, def.feature));
}

// Where to go when leaving `activeTab`: its `leaveTo` tab when the user can see
// that one, otherwise the first visible tab.
export function leaveTarget(activeTab, visibleTabs) {
  const to = ADMIN_TABS.find(t => t.key === activeTab)?.leaveTo;
  return visibleTabs.some(t => t.key === to) ? to : (visibleTabs[0]?.key || 'crawlers');
}
