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

// Each entry is a small component that takes the shared render context as PROPS
// and renders its page; multi-key routes (resources/groups; performance/crawlers/
// admin) share one component so the markup isn't duplicated.
const GroupsRoute = ({ openDetailTab }) => <GroupsPage onOpenDetail={openDetailTab} />;
// Crawlers and Performance live under Admin as sub-tabs; the legacy #crawlers /
// #performance hashes render AdminPage, which routes to the matching sub-tab.
const AdminRoute = ({ navigate, forceRefresh, onRiskScoresRefresh }) => (
  <AdminPage onNavigate={navigate} onRefresh={forceRefresh} onRiskScoresRefresh={onRiskScoresRefresh} />
);

// pageKey → component. Two things make dispatch on the user-controlled hash key
// provably safe (CodeQL js/unvalidated-dynamic-method-call):
//   1. a Map lookup can only return an explicitly-added entry — never an
//      inherited Object.prototype member (`constructor`, `toString`, …); and
//   2. App.jsx builds the resolved entry as an element (`createElement(route, ctx)`)
//      rather than calling it (`route(ctx)`), so the user-controlled key never
//      lands in callee position of an invocation.
// The context props: { navigate, openDetailTab, forceRefresh, riskScoresRefreshKey,
// onRiskScoresRefresh }.
export const PAGE_ROUTES = new Map([
  ['dashboard',       ({ navigate }) => <DashboardPage onNavigate={navigate} />],
  ['sync-log',        ({ navigate, openDetailTab }) => <SyncLogPage navigate={navigate} onOpenDetail={openDetailTab} />],
  ['principals',      ({ openDetailTab }) => <UsersPage onOpenDetail={openDetailTab} />],
  ['resources',       GroupsRoute],
  ['groups',          GroupsRoute],
  ['systems',         () => <SystemsPage />],
  ['access-packages', ({ openDetailTab }) => <AccessPackagesPage onOpenDetail={openDetailTab} />],
  ['risk-scores',     ({ openDetailTab, riskScoresRefreshKey }) => <RiskScoringPage key={riskScoresRefreshKey} onOpenDetail={openDetailTab} />],
  ['identities',      ({ openDetailTab }) => <IdentitiesPage onOpenDetail={openDetailTab} />],
  ['contexts',        ({ navigate, openDetailTab }) => <ContextsPage onOpenDetail={openDetailTab} onNavigate={navigate} />],
  ['performance',     AdminRoute],
  ['crawlers',        AdminRoute],
  ['admin',           AdminRoute],
]);

// The route component for a static page key, or null when the key is a detail tab
// / matrix / unknown route (all handled by App.jsx).
export function resolvePageRoute(page) {
  return PAGE_ROUTES.get(page) ?? null;
}
