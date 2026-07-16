/* eslint-disable react-refresh/only-export-components --
   This is a route table, not a Fast-Refresh component module: it exports the
   PAGE_ROUTES map + resolvePageRoute helper, and the lazy() consts are internal
   route targets, never re-rendered in place by HMR. */
// Static page-route registry for the app shell.
//
// Maps a hash page-key to a render function that builds its page element from the
// shared render context. This is deliberately a DATA MAP, not the big JSX ternary
// it replaced in App.jsx: v8 does not line-instrument the arms of a JSX ternary,
// so every routing edit (add / rename / reorder a tab) tripped the diff-coverage
// gate on an un-coverable changed line (#669). As instrumented map entries +
// render-function statements, each route IS executed — and therefore covered — by
// a test that resolves its key, and a routing change is a one-line data edit here
// rather than an edit to an un-line-instrumentable JSX arm in App.jsx.
//
// Scope: STATIC pages only. The dynamic detail tabs (#user:, #group:, …) and the
// matrix view stay in App.jsx — they need surrounding app state (the detail-tab
// cache, the matrix filter/wizard wiring) and are the pure-JSX shells v8 can't
// line-instrument regardless of where they live (covered by e2e instead; the
// remaining shell blind spot is tracked separately).

import { lazy } from 'react';

const DashboardPage = lazy(() => import('./components/DashboardPage'));
const SyncLogPage = lazy(() => import('./components/SyncLogPage'));
const UsersPage = lazy(() => import('./components/UsersPage'));
const GroupsPage = lazy(() => import('./components/GroupsPage')); // renders ResourcesPage
const AccessPackagesPage = lazy(() => import('./components/AccessPackagesPage'));
const SystemsPage = lazy(() => import('./components/SystemsPage'));
const RiskScoringPage = lazy(() => import('./components/RiskScoringPage'));
const ContextsPage = lazy(() => import('./components/ContextsPage'));
const IdentitiesPage = lazy(() => import('./components/IdentitiesPage'));
const AdminPage = lazy(() => import('./components/AdminPage'));

// Render functions defined once and aliased to every key that shows the same page,
// so multi-key routes (resources/groups; performance/crawlers/admin) don't
// duplicate the element markup.
const renderGroups = (ctx) => <GroupsPage onOpenDetail={ctx.openDetailTab} />;
// Crawlers and Performance live under Admin as sub-tabs; the legacy #crawlers /
// #performance hashes render AdminPage, which routes to the matching sub-tab.
const renderAdmin = (ctx) => (
  <AdminPage onNavigate={ctx.navigate} onRefresh={ctx.forceRefresh} onRiskScoresRefresh={ctx.onRiskScoresRefresh} />
);

// key → (ctx) => element. `ctx` carries { navigate, openDetailTab, forceRefresh,
// riskScoresRefreshKey, onRiskScoresRefresh }.
//
// A Map (not a plain object) is deliberate: `page` comes from the URL hash
// (user-controlled), and a Map lookup can only ever return an explicitly-added
// entry — never an inherited Object.prototype member (`constructor`, `toString`,
// …). That closes the "unvalidated dynamic method call" class flat (CodeQL
// js/unvalidated-dynamic-method-call) without an own-property guard.
export const PAGE_ROUTES = new Map([
  ['dashboard',       (ctx) => <DashboardPage onNavigate={ctx.navigate} />],
  ['sync-log',        (ctx) => <SyncLogPage navigate={ctx.navigate} onOpenDetail={ctx.openDetailTab} />],
  ['principals',      (ctx) => <UsersPage onOpenDetail={ctx.openDetailTab} />],
  ['resources',       renderGroups],
  ['groups',          renderGroups],
  ['systems',         () => <SystemsPage />],
  ['access-packages', (ctx) => <AccessPackagesPage onOpenDetail={ctx.openDetailTab} />],
  ['risk-scores',     (ctx) => <RiskScoringPage key={ctx.riskScoresRefreshKey} onOpenDetail={ctx.openDetailTab} />],
  ['identities',      (ctx) => <IdentitiesPage onOpenDetail={ctx.openDetailTab} />],
  ['contexts',        (ctx) => <ContextsPage onOpenDetail={ctx.openDetailTab} onNavigate={ctx.navigate} />],
  ['performance',     renderAdmin],
  ['crawlers',        renderAdmin],
  ['admin',           renderAdmin],
]);

// The render function for a static page key, or null when the key is a detail tab
// / matrix / unknown route (all handled by App.jsx).
export function resolvePageRoute(page) {
  return PAGE_ROUTES.get(page) ?? null;
}
