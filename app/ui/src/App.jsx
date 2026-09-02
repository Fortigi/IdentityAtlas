import { useState, useEffect, useReducer, useCallback, useMemo, useRef } from 'react';

// useState-equivalent backed by useReducer (value + functional updates):
// dispatch isn't flagged by react-hooks/set-state-in-effect, so the detail-tab
// and matrix auto-open effects below can dispatch instead of setState.
const setStateReducer = (s, a) => (typeof a === 'function' ? a(s) : a);
import { useMatrix } from './hooks/useMatrix';
import { useAuth } from './auth/AuthGate';
import { useCanSeeAdminTab } from './auth/usePermissions';
import { useTheme } from './hooks/useTheme';
import { useAttributeLabels } from './hooks/useAttributeLabels';
import { ThemeContext } from './contexts/ThemeContext';
import { computeNavTabs, availableOptionalTabs } from './utils/navTabs';
import ErrorBoundary from './components/ErrorBoundary';
import { resolvePageRoute } from './pageRegistry';
import { isDetailPage, parseDetailRoute, pickDisplayName, closeFallbackPage } from './App.helpers';
import AppHeader from './components/app/AppHeader';
import AppMain from './components/app/AppMain';
import AppFooter from './components/app/AppFooter';
import BackendErrorScreen from './components/app/BackendErrorScreen';

// The matrix + detail page components are lazy-loaded inside AppMain's regions
// (MatrixArea / DetailRoute); the static page components resolve through
// ./pageRegistry (resolvePageRoute below and the #669 note in that file).

// ─── URL helpers ──────────────────────────────────────────────────

function parseHash() {
  const raw = decodeURIComponent(window.location.hash.replace('#', '') || 'dashboard');
  const qIndex = raw.indexOf('?');
  const page = qIndex >= 0 ? raw.substring(0, qIndex) : raw;
  const params = new URLSearchParams(qIndex >= 0 ? raw.substring(qIndex + 1) : '');
  return { page, params };
}

// Matrix URL state: a single `filter` param holds the wizard filter as
// URL-encoded JSON, plus a `managed` param for the IST/SOLL/Gaps toggle.
// Old `f.*` / `cf` / `limit` params (pre-wizard) are silently ignored — the
// matrix shows its empty state until the user re-applies a filter.
function parseMatrixParams(params) {
  let filter = null;
  if (params.has('filter')) {
    try {
      const parsed = JSON.parse(params.get('filter'));
      if (parsed && typeof parsed === 'object') filter = parsed;
    } catch { /* ignore malformed filter */ }
  }
  const managed = params.get('managed') || 'all';
  return { filter, managed };
}

function buildMatrixHash(state) {
  const params = new URLSearchParams();
  if (state.filter) {
    params.set('filter', JSON.stringify(state.filter));
  }
  if (state.managed && state.managed !== 'all') params.set('managed', state.managed);
  const qs = params.toString();
  return `matrix${qs ? '?' + qs : ''}`;
}

function buildMatrixUrl(state) {
  const hash = buildMatrixHash(state);
  return `${window.location.origin}${window.location.pathname}#${hash}`;
}

// ─── Hash route hook ──────────────────────────────────────────────

function useHashRoute() {
  const getPage = () => {
    const raw = decodeURIComponent(window.location.hash.replace('#', '') || 'dashboard');
    const qIndex = raw.indexOf('?');
    return qIndex >= 0 ? raw.substring(0, qIndex) : raw;
  };
  const [page, setPage] = useState(getPage());
  useEffect(() => {
    const onHash = () => setPage(getPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((p) => { window.location.hash = p; }, []);
  return [page, navigate];
}

export default function App() {
  // Parse initial state from URL (runs once — empty deps intentional)
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const initial = useMemo(() => {
    const { page, params } = parseHash();
    if (page === 'matrix') return parseMatrixParams(params);
    return { filter: null, managed: 'all' };
  }, []);

  // Wizard-driven matrix state: a single filter object + managed-state toggle
  const [matrixFilter, setMatrixFilter] = useReducer(setStateReducer, initial.filter);
  const [managedFilter, setManagedFilter] = useReducer(setStateReducer, initial.managed);
  const [wizardOpen, setWizardOpen] = useReducer(setStateReducer, false);

  const { data, rollup, counts, accessPackageGroups, managedByPackages, resourceContexts, groupTagMap, loading, refreshing, error, forceRefresh, hasData, defaultFilter, refetchPreChecks } = useMatrix(matrixFilter);
  const { account, logout, authFetch } = useAuth();
  const [page, navigate] = useHashRoute();
  const [moduleVersion, setModuleVersion] = useState(null);
  const [features, setFeatures] = useState({ riskScoring: true, accountLinking: true });
  const [visibleTabs, setVisibleTabs] = useState(null); // null = loading, [] = loaded
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(null);
  const [riskScoresRefreshKey, setRiskScoresRefreshKey] = useState(0);
  const { isDark, mode, setTheme } = useTheme();

  // Warm the shared extendedAttributes display-name cache once for the whole app,
  // so every attribute name — detail tables, filter menus, matrix headers and
  // pickers, the xlsx export — reads the same server-resolved string (#872).
  useAttributeLabels();

  // Hide the Admin tab from users with no admin.* permission. Clicking it
  // would 403 on every sub-page anyway — better not to advertise the door
  // than to let them find a locked one. The Auth → Roles & Permissions
  // page inside Admin further self-gates by admin.auth.
  const canSeeAdmin = useCanSeeAdminTab();

  const navTabs = useMemo(
    () => computeNavTabs({ features, visibleTabs, canSeeAdmin }),
    [features, visibleTabs, canSeeAdmin]
  );

  // Available optional tabs (respecting feature flags)
  const optionalTabs = useMemo(() => availableOptionalTabs(features), [features]);

  // The Dashboard page handles the no-data case with its own "Configure a
  // crawler" CTA. In v5 the default landing page is the Dashboard — the old
  // first-visit redirect that jumped to Admin → Crawlers is no longer needed
  // because the Dashboard IS the onboarding surface.

  useEffect(() => {
    fetch('/api/version').then(r => r.json()).then(d => setModuleVersion(d.version)).catch(() => {});
    fetch('/api/features').then(r => r.json()).then(d => setFeatures(d)).catch(() => {});
  }, []);

  // Re-fetch features whenever the user navigates — picks up runtime toggle changes
  // from the admin Risk Scoring sub-tab so the feature-gated Risk Scores / Identities
  // tabs appear or disappear without a hard reload.
  useEffect(() => {
    fetch('/api/features').then(r => r.json()).then(d => setFeatures(d)).catch(() => {});
  }, [page]);

  // Load user preferences
  useEffect(() => {
    authFetch('/api/preferences')
      .then(r => r.json())
      .then(d => setVisibleTabs(d.visibleTabs || []))
      .catch(() => setVisibleTabs([]));
  }, [authFetch]);

  const toggleTab = useCallback((tabKey) => {
    setVisibleTabs(prev => {
      const next = prev.includes(tabKey)
        ? prev.filter(k => k !== tabKey)
        : [...prev, tabKey];
      // Save to backend
      authFetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibleTabs: next }),
      }).catch(() => {});
      return next;
    });
  }, [authFetch]);

  // Close settings dropdown on outside click
  useEffect(() => {
    if (!settingsOpen) return;
    const handleClick = (e) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [settingsOpen]);

  // ─── Dynamic detail tabs ──────────────────────────────────────
  // Each entry: { type: 'user'|'group', id, displayName }
  const [detailTabs, setDetailTabs] = useReducer(setStateReducer, undefined, () => {
    // Restore detail tab from URL on load (e.g., bookmarked #user:abc)
    const { page: initPage } = parseHash();
    const route = parseDetailRoute(initPage);
    return route ? [{ type: route.type, id: route.id, displayName: route.id }] : [];
  });

  // ─── Detail data cache ─────────────────────────────────────────
  // Keyed by "type:id", stores { core, memberships, accessPackages, history }
  const detailCacheRef = useRef({});

  const onCacheData = useCallback((id, type, partialData) => {
    const key = `${type}:${id}`;
    detailCacheRef.current[key] = { ...detailCacheRef.current[key], ...partialData };
    // When a detail page loads its entity data, update the tab label from the
    // display name embedded in the payload. This fixes the case where a tab was
    // opened via direct URL navigation and only had the UUID as a placeholder.
    const displayName = pickDisplayName(partialData);
    if (displayName) {
      // Match by id only (not type) because some routes use different type keys:
      // e.g. #group: opens ResourceDetailPage which calls onCacheData with type='resource'
      // but the tab was created with type='group'.
      setDetailTabs(prev => prev.map(t =>
        t.id === id && t.displayName === id
          ? { ...t, displayName }
          : t
      ));
    }
  }, []);

  const openDetailTab = useCallback((type, id, displayName) => {
    const tabKey = `${type}:${id}`;
    setDetailTabs(prev => {
      if (prev.some(t => `${t.type}:${t.id}` === tabKey)) return prev;
      // Store the current page so closing this tab can return to where we came from
      return [...prev, { type, id, displayName: displayName || id, returnPage: page }];
    });
    navigate(tabKey);
  }, [navigate, page]);

  const closeDetailTab = useCallback((type, id) => {
    const tabKey = `${type}:${id}`;
    const isActive = window.location.hash.replace('#', '') === tabKey;
    setDetailTabs(prev => {
      const idx = prev.findIndex(t => `${t.type}:${t.id}` === tabKey);
      const closing = prev[idx];
      // Any tab that pointed back to this one inherits this tab's returnPage,
      // so closing an intermediate tab doesn't resurrect it later.
      const remaining = prev
        .filter(t => `${t.type}:${t.id}` !== tabKey)
        .map(t => t.returnPage === tabKey ? { ...t, returnPage: closing?.returnPage } : t);
      // Only navigate when closing the active tab
      if (isActive) {
        navigate(closing?.returnPage ?? closeFallbackPage(type));
      }
      return remaining;
    });
    delete detailCacheRef.current[tabKey];
  }, [navigate]);

  // When navigating to a detail tab via URL that isn't tracked yet, add it
  useEffect(() => {
    const route = parseDetailRoute(page);
    if (!route) return;
    setDetailTabs(prev => {
      if (prev.some(t => t.type === route.type && t.id === route.id)) return prev;
      return [...prev, { type: route.type, id: route.id, displayName: route.id }];
    });
  }, [page]);

  // When the user lands on the matrix tab without an applied filter:
  //  - If a default filter is seeded (e.g. demo data): auto-apply it, no wizard.
  //  - If there IS data but no default filter: open the wizard.
  //  - If the DB is empty: do nothing (EmptyFilterState shows "no data" message).
  // We wait until both hasData and defaultFilter have resolved (neither null/undefined
  // as "still loading") before acting. autoOpenFiredRef prevents re-firing after the
  // user closes the wizard or navigates away and back.
  const prevPageRef = useRef(null);
  const autoOpenFiredRef = useRef(false);
  useEffect(() => {
    const freshNav = page === 'matrix' && prevPageRef.current !== 'matrix';
    prevPageRef.current = page;
    if (freshNav) {
      autoOpenFiredRef.current = false;
      // Re-check DB state on every fresh nav — picks up data loaded since mount
      // (e.g. demo import or crawler run completed while on another tab).
      // Return immediately so the auto-open logic only runs once the fresh
      // values land; the version bump resets hasData/defaultFilter to their
      // loading states, which holds the gate until the fetch resolves.
      if (!matrixFilter) { refetchPreChecks(); return; }
    }
    if (page !== 'matrix' || autoOpenFiredRef.current || matrixFilter || wizardOpen) return;
    // Still waiting for hasData or defaultFilter to resolve
    if (hasData === null || defaultFilter === undefined) return;
    if (hasData === false) return; // don't lock out — DB may get data after import
    autoOpenFiredRef.current = true;
    if (defaultFilter !== null) {
      // skip wizard, apply saved default — restore its managed-state toggle too
      const { managed: savedManaged, ...f } = defaultFilter.filter || {};
      setMatrixFilter(f);
      if (savedManaged) setManagedFilter(savedManaged);
    } else {
      setWizardOpen(true); // no default — let user configure
    }
  }, [page, matrixFilter, wizardOpen, hasData, defaultFilter, refetchPreChecks]);

  // Sync URL when on matrix page (debounced replaceState — no history entry)
  useEffect(() => {
    if (page !== 'matrix') return;
    const timer = setTimeout(() => {
      const newHash = buildMatrixHash({
        filter: matrixFilter,
        managed: managedFilter,
      });
      if (window.location.hash !== '#' + newHash) {
        history.replaceState(null, '', '#' + newHash);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [page, matrixFilter, managedFilter]);

  // Build shareable URL (stable reference for children)
  const shareUrl = useMemo(() => buildMatrixUrl({
    filter: matrixFilter,
    managed: managedFilter,
  }), [matrixFilter, managedFilter]);

  if (error) {
    return <BackendErrorScreen error={error} />;
  }

  // Static (non-detail, non-matrix) page routes resolve through the instrumented
  // pageRegistry map (#669) — a routing edit is a one-line data change there, not
  // an un-line-instrumentable JSX ternary arm.
  const isDetail = isDetailPage(page);
  const staticRoute = isDetail ? null : resolvePageRoute(page);
  const pageCtx = {
    navigate,
    openDetailTab,
    forceRefresh,
    riskScoresRefreshKey,
    onRiskScoresRefresh: () => setRiskScoresRefreshKey(k => k + 1),
  };

  const detailRouteProps = { page, detailCacheRef, onCacheData, openDetailTab, closeDetailTab };
  const matrixProps = {
    rollup, data, matrixFilter, counts, managedFilter, setManagedFilter,
    shareUrl, refreshing, onOpenDetail: openDetailTab, setMatrixFilter,
    accessPackageGroups, managedByPackages, resourceContexts, groupTagMap, hasData,
    wizardOpen,
    onAdjustFilter: () => setWizardOpen(true),
    onWizardApply: (f, m) => { setMatrixFilter(f); if (m) setManagedFilter(m); setWizardOpen(false); },
    onWizardClose: () => setWizardOpen(false),
  };

  return (
    <ThemeContext.Provider value={{ isDark, mode }}>
    <ErrorBoundary>
    <div className="flex-1 min-h-0 flex flex-col bg-gray-50 dark:bg-gray-900">
      {/* Skip link — first focusable element, visible only when focused */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[100] focus:rounded focus:bg-blue-600 focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to main content
      </a>

      <AppHeader
        isDark={isDark}
        settingsRef={settingsRef}
        account={account}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen(prev => !prev)}
        onCloseSettings={() => setSettingsOpen(false)}
        mode={mode}
        setTheme={setTheme}
        optionalTabs={optionalTabs}
        visibleTabs={visibleTabs}
        toggleTab={toggleTab}
        logout={logout}
        navTabs={navTabs}
        detailTabs={detailTabs}
        page={page}
        navigate={navigate}
        closeDetailTab={closeDetailTab}
      />

      <AppMain
        isDetail={isDetail}
        detailRouteProps={detailRouteProps}
        staticRoute={staticRoute}
        pageCtx={pageCtx}
        loading={loading}
        matrixProps={matrixProps}
      />

      <AppFooter moduleVersion={moduleVersion} navigate={navigate} />
    </div>
    </ErrorBoundary>
    </ThemeContext.Provider>
  );
}
