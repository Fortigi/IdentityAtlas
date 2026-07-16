import { useState, useEffect, useReducer, useCallback, useMemo, useRef, lazy, Suspense } from 'react';

// useState-equivalent backed by useReducer (value + functional updates):
// dispatch isn't flagged by react-hooks/set-state-in-effect, so the detail-tab
// and matrix auto-open effects below can dispatch instead of setState.
const setStateReducer = (s, a) => (typeof a === 'function' ? a(s) : a);
import { useMatrix } from './hooks/useMatrix';
import { useAuth } from './auth/AuthGate';
import { useCanSeeAdminTab } from './auth/usePermissions';
import { useTheme } from './hooks/useTheme';
import { ThemeContext } from './contexts/ThemeContext';
import { computeNavTabs, availableOptionalTabs } from './utils/navTabs';
import { tabBadge } from './utils/tabBadge';
import ErrorBoundary from './components/ErrorBoundary';
import { resolvePageRoute } from './pageRegistry';

// Lazy-load the matrix + detail page components (route-based code splitting).
// The static page components (dashboard, principals, systems, admin, …) live in
// ./pageRegistry — see resolvePageRoute below and the #669 note in that file.
const MatrixView = lazy(() => import('./components/MatrixView'));
const RotatedMatrixView = lazy(() => import('./components/RotatedMatrixView'));
const RollupMatrixView = lazy(() => import('./components/RollupMatrixView'));
const MatrixFilterWizard = lazy(() => import('./components/matrix/MatrixFilterWizard'));
const UserDetailPage = lazy(() => import('./components/UserDetailPage'));
const ResourceDetailPage = lazy(() => import('./components/ResourceDetailPage'));
const AccessPackageDetailPage = lazy(() => import('./components/AccessPackageDetailPage'));
const DepartmentDetailPage = lazy(() => import('./components/DepartmentDetailPage'));
const ContextDetailPage = lazy(() => import('./components/ContextDetailPage'));
const RunDetailPage = lazy(() => import('./components/RunDetailPage'));
const IdentityDetailPage = lazy(() => import('./components/IdentityDetailPage'));
// PerfPage and CrawlersPage are lazy-loaded inside AdminPage as sub-tabs.
// const GovernancePage = lazy(() => import('./components/GovernancePage')); // temporarily disabled

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

  const { data, rollup, counts, accessPackageGroups, managedByPackages, groupTagMap, loading, refreshing, error, forceRefresh, hasData, defaultFilter, refetchPreChecks } = useMatrix(matrixFilter);
  const { account, logout, authFetch } = useAuth();
  const [page, navigate] = useHashRoute();
  const [moduleVersion, setModuleVersion] = useState(null);
  const [features, setFeatures] = useState({ riskScoring: true, accountLinking: true });
  const [visibleTabs, setVisibleTabs] = useState(null); // null = loading, [] = loaded
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(null);
  const [riskScoresRefreshKey, setRiskScoresRefreshKey] = useState(0);
  const { isDark, mode, setTheme } = useTheme();

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
  // from the admin Risk Scoring sub-tab so the optional Risk Scores / Identities / Org Chart
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
    if (initPage.startsWith('user:') || initPage.startsWith('group:') || initPage.startsWith('resource:') || initPage.startsWith('access-package:') || initPage.startsWith('department:') || initPage.startsWith('context:') || initPage.startsWith('identity:') || initPage.startsWith('run:')) {
      const sepIdx = initPage.indexOf(':');
      const type = initPage.substring(0, sepIdx);
      const id = initPage.substring(sepIdx + 1);
      return [{ type, id, displayName: id }];
    }
    return [];
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
    const displayName =
      partialData?.identity?.displayName           ||   // identity detail: { identity: { displayName } }
      partialData?.core?.attributes?.displayName   ||   // group/resource: { core: { attributes: { displayName } } }
      partialData?.core?.displayName               ||   // user detail: { core: { displayName } }
      partialData?.attributes?.displayName         ||   // direct attributes
      partialData?.displayName;                         // flat shape
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
        navigate(closing?.returnPage ?? (type === 'run' ? 'contexts' : type === 'department' || type === 'context' ? 'contexts' : type === 'identity' ? 'identities' : type === 'resource' ? 'resources' : 'matrix'));
      }
      return remaining;
    });
    delete detailCacheRef.current[tabKey];
  }, [navigate]);

  // When navigating to a detail tab via URL that isn't tracked yet, add it
  useEffect(() => {
    if (page.startsWith('user:') || page.startsWith('group:') || page.startsWith('resource:') || page.startsWith('access-package:') || page.startsWith('department:') || page.startsWith('context:') || page.startsWith('identity:') || page.startsWith('run:')) {
      const sepIdx = page.indexOf(':');
      const type = page.substring(0, sepIdx);
      const id = page.substring(sepIdx + 1);
      setDetailTabs(prev => {
        if (prev.some(t => t.type === type && t.id === id)) return prev;
        return [...prev, { type, id, displayName: id }];
      });
    }
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

  // Check if current page is a detail tab
  const isDetailPage = page.startsWith('user:') || page.startsWith('group:') || page.startsWith('resource:') || page.startsWith('access-package:') || page.startsWith('department:') || page.startsWith('context:') || page.startsWith('identity:') || page.startsWith('run:');

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-6 max-w-md">
          <h2 className="text-red-800 dark:text-red-300 font-semibold text-lg">Backend not responding</h2>
          <p className="text-red-600 dark:text-red-400 mt-2 text-sm">{error}</p>
          <p className="text-red-500 dark:text-red-400 mt-2 text-xs">
            If a crawler is currently running, this page may be temporarily slow — wait a moment and refresh.
            Otherwise check that the web container is running: <code className="bg-red-100 dark:bg-red-900 px-1 rounded">docker compose ps web</code> · <code className="bg-red-100 dark:bg-red-900 px-1 rounded">docker compose logs web</code>
          </p>
        </div>
      </div>
    );
  }

  // Render detail page content
  const renderDetailPage = () => {
    if (page.startsWith('user:')) {
      const id = page.substring(5);
      const cacheKey = `user:${id}`;
      return <UserDetailPage key={cacheKey} userId={id} cachedData={detailCacheRef.current[cacheKey]} onCacheData={onCacheData} onClose={() => closeDetailTab('user', id)} onOpenDetail={openDetailTab} />;
    }
    if (page.startsWith('resource:')) {
      const id = page.substring(9);
      const cacheKey = `resource:${id}`;
      return <ResourceDetailPage key={cacheKey} resourceId={id} cachedData={detailCacheRef.current[cacheKey]} onCacheData={onCacheData} onClose={() => closeDetailTab('resource', id)} onOpenDetail={openDetailTab} />;
    }
    if (page.startsWith('group:')) {
      // Backward compat: #group:id opens ResourceDetailPage
      const id = page.substring(6);
      const cacheKey = `group:${id}`;
      return <ResourceDetailPage key={cacheKey} resourceId={id} cachedData={detailCacheRef.current[cacheKey]} onCacheData={onCacheData} onClose={() => closeDetailTab('group', id)} onOpenDetail={openDetailTab} />;
    }
    if (page.startsWith('access-package:')) {
      const id = page.substring(15);
      const cacheKey = `access-package:${id}`;
      return <AccessPackageDetailPage key={cacheKey} accessPackageId={id} cachedData={detailCacheRef.current[cacheKey]} onCacheData={onCacheData} onClose={() => closeDetailTab('access-package', id)} onOpenDetail={openDetailTab} />;
    }
    if (page.startsWith('department:')) {
      const name = page.substring(11);
      const cacheKey = `department:${name}`;
      return <DepartmentDetailPage key={cacheKey} departmentName={name} cachedData={detailCacheRef.current[cacheKey]} onCacheData={onCacheData} onClose={() => closeDetailTab('department', name)} onOpenDetail={openDetailTab} />;
    }
    if (page.startsWith('context:')) {
      const id = page.substring(8);
      const cacheKey = `context:${id}`;
      return <ContextDetailPage key={cacheKey} contextId={id} cachedData={detailCacheRef.current[cacheKey]} onCacheData={onCacheData} onClose={() => closeDetailTab('context', id)} onOpenDetail={openDetailTab} />;
    }
    if (page.startsWith('identity:')) {
      const id = page.substring(9);
      const cacheKey = `identity:${id}`;
      return <IdentityDetailPage key={cacheKey} identityId={id} cachedData={detailCacheRef.current[cacheKey]} onCacheData={onCacheData} onClose={() => closeDetailTab('identity', id)} onOpenDetail={openDetailTab} />;
    }
    if (page.startsWith('run:')) {
      const id = page.substring(4);
      const cacheKey = `run:${id}`;
      return <RunDetailPage key={cacheKey} runId={id} onClose={() => closeDetailTab('run', id)} onOpenDetail={openDetailTab} />;
    }
    return null;
  };

  // Static (non-detail, non-matrix) page routes resolve through the instrumented
  // pageRegistry map (#669) — a routing edit is a one-line data change there, not
  // an un-line-instrumentable JSX ternary arm in the return below.
  const staticRoute = isDetailPage ? null : resolvePageRoute(page);
  const pageCtx = {
    navigate,
    openDetailTab,
    forceRefresh,
    riskScoresRefreshKey,
    onRiskScoresRefresh: () => setRiskScoresRefreshKey(k => k + 1),
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
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={isDark ? '/logo-dark.png' : '/logo.png'} alt="Identity Atlas" className="h-10 w-10 rounded-lg" />
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Identity <span className="text-lime-700 dark:text-lime-400">Atlas</span></h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Universal authorization intelligence
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 relative" ref={settingsRef}>
            <button
              onClick={() => setSettingsOpen(prev => !prev)}
              className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="Settings"
            >
              <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-bold">
                {(account?.name || account?.username || '?')[0].toUpperCase()}
              </div>
              <span className="hidden sm:inline">{account?.name || account?.username || 'User'}</span>
              <svg className={`w-3.5 h-3.5 text-gray-600 dark:text-gray-500 transition-transform ${settingsOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {settingsOpen && (
              <div className="absolute right-0 top-full mt-1 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50">
                {/* User info */}
                <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{account?.name || 'User'}</p>
                  {account?.username && <p className="text-xs text-gray-500 dark:text-gray-400">{account.username}</p>}
                </div>

                {/* Theme selector */}
                <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-gray-700 dark:text-gray-300 shrink-0">Theme</span>
                    <div className="flex items-center rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden text-xs">
                      {[
                        {
                          value: 'light', label: 'Light',
                          icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="5" strokeWidth={2}/>
                            <path strokeWidth={2} strokeLinecap="round"
                              d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
                          </svg>,
                        },
                        {
                          value: 'auto', label: 'Auto',
                          icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <rect x="2" y="3" width="20" height="14" rx="2" strokeWidth={2}/>
                            <path strokeWidth={2} strokeLinecap="round" d="M8 21h8M12 17v4"/>
                          </svg>,
                        },
                        {
                          value: 'dark', label: 'Dark',
                          icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeWidth={2} strokeLinecap="round"
                              d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/>
                          </svg>,
                        },
                      ].map(({ value, label, icon }) => (
                        <button
                          key={value}
                          onClick={() => setTheme(value)}
                          aria-label={label}
                          aria-pressed={mode === value}
                          className={`flex items-center gap-1 px-2.5 py-1.5 transition-colors ${
                            mode === value
                              ? 'bg-blue-500 text-white'
                              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                          }`}
                        >
                          {icon}
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Tab visibility toggles */}
                <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
                  <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Visible Tabs</p>
                  {optionalTabs.map(tab => (
                    <label key={tab.key} className="flex items-center justify-between py-1.5 cursor-pointer group">
                      <span className="text-sm text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-white">{tab.label}</span>
                      <button
                        onClick={() => toggleTab(tab.key)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          visibleTabs?.includes(tab.key) ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                        }`}
                      >
                        <span
                          className="inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform"
                          style={{ transform: visibleTabs?.includes(tab.key) ? 'translateX(18px)' : 'translateX(2px)' }}
                        />
                      </button>
                    </label>
                  ))}
                </div>

                {/* Sign out */}
                {account && (
                  <div className="px-4 py-2">
                    <button
                      onClick={() => { setSettingsOpen(false); logout(); }}
                      className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 w-full text-left py-1"
                    >
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Tab navigation */}
        <nav className="flex items-center gap-1 mt-3 -mb-4 border-b-0 overflow-x-auto">
          {navTabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => navigate(tab.key)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg border border-b-0 transition-colors whitespace-nowrap ${
                page === tab.key
                  ? 'bg-gray-50 dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-gray-200 dark:border-gray-600'
                  : 'bg-transparent text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50'
              }`}
            >
              {tab.label}
            </button>
          ))}

          {/* Dynamic detail tabs */}
          {detailTabs.map(tab => {
            const tabKey = `${tab.type}:${tab.id}`;
            const isActive = page === tabKey;
            const icon = tabBadge(tab.type);
            const iconBg = tab.type === 'user' ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300' : tab.type === 'resource' ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300' : tab.type === 'group' ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300' : tab.type === 'department' ? 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300' : tab.type === 'context' ? 'bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300' : 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300';
            return (
              <button
                key={tabKey}
                onClick={() => navigate(tabKey)}
                className={`group flex items-center gap-1.5 pl-2 pr-1 py-2 text-sm font-medium rounded-t-lg border border-b-0 transition-colors whitespace-nowrap max-w-[200px] ${
                  isActive
                    ? 'bg-gray-50 dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-gray-200 dark:border-gray-600'
                    : 'bg-transparent text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                }`}
              >
                <span className={`inline-flex items-center justify-center w-4 h-4 rounded-sm text-[9px] font-bold ${iconBg}`}>{icon}</span>
                <span className="truncate max-w-[140px]">{tab.displayName}</span>
                <span
                  onClick={(e) => { e.stopPropagation(); closeDetailTab(tab.type, tab.id); }}
                  className="ml-0.5 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Close"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </span>
              </button>
            );
          })}
        </nav>
      </header>

      {/* Content */}
      <main id="main-content" className="p-6">
        <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="text-gray-500 dark:text-gray-400">Loading...</div></div>}>
          {isDetailPage ? (
            // renderDetailPage reads detailCacheRef — an intentional mutable
            // per-tab render-cache (cachedData for instant detail display).
            // Making it state would re-render the whole app on every cache
            // write, which is exactly what the ref avoids.
            // eslint-disable-next-line react-hooks/refs
            renderDetailPage()
          ) : staticRoute ? (
            // Static pages (dashboard, principals, systems, admin + its legacy
            // #crawlers / #performance aliases, …) come from the instrumented
            // pageRegistry map — see resolvePageRoute / #669.
            staticRoute(pageCtx)
          ) : loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-500 dark:text-gray-400">Loading permission data...</div>
            </div>
          ) : (
            <>
              {rollup ? (
                <RollupMatrixView
                  rollup={rollup}
                  filter={matrixFilter}
                  counts={counts}
                  managedFilter={managedFilter}
                  setManagedFilter={setManagedFilter}
                  shareUrl={shareUrl}
                  refreshing={refreshing}
                  onOpenDetail={openDetailTab}
                  onAdjustFilter={() => setWizardOpen(true)}
                  onFilterChange={setMatrixFilter}
                />
              ) : matrixFilter?.orientation === 'rows-as-subjects' ? (
                <RotatedMatrixView
                  data={data}
                  filter={matrixFilter}
                  counts={counts}
                  managedFilter={managedFilter}
                  setManagedFilter={setManagedFilter}
                  refreshing={refreshing}
                  shareUrl={shareUrl}
                  onOpenDetail={openDetailTab}
                  onAdjustFilter={() => setWizardOpen(true)}
                  hasData={hasData}
                />
              ) : (
                <MatrixView
                  data={data}
                  accessPackageGroups={accessPackageGroups}
                  managedByPackages={managedByPackages}
                  filter={matrixFilter}
                  counts={counts}
                  managedFilter={managedFilter}
                  setManagedFilter={setManagedFilter}
                  groupTagMap={groupTagMap}
                  refreshing={refreshing}
                  shareUrl={shareUrl}
                  onOpenDetail={openDetailTab}
                  onAdjustFilter={() => setWizardOpen(true)}
                  hasData={hasData}
                />
              )}
              <MatrixFilterWizard
                open={wizardOpen}
                initialFilter={matrixFilter}
                initialManaged={managedFilter}
                onApply={(f, m) => { setMatrixFilter(f); if (m) setManagedFilter(m); setWizardOpen(false); }}
                onClose={() => setWizardOpen(false)}
              />
            </>
          )}
        </Suspense>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-6 py-2 text-xs text-gray-600 dark:text-gray-500 text-center flex items-center justify-center gap-2">
        <button
          onClick={() => navigate('admin?sub=about')}
          className="hover:text-gray-600 dark:hover:text-gray-300 hover:underline focus:outline-none"
        >
          Identity Atlas{moduleVersion ? ` v${moduleVersion}` : ''}
        </button>
        {/^\d+\.\d+\.\d{8}\.\d{4}$/.test(moduleVersion) && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700">
            edge
          </span>
        )}
      </footer>
    </div>
    </ErrorBoundary>
    </ThemeContext.Provider>
  );
}
