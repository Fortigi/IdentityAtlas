import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { usePermissions } from './hooks/usePermissions';
import { useAuth } from './auth/AuthGate';
import ErrorBoundary from './components/ErrorBoundary';

// Lazy-load page components (route-based code splitting)
const DashboardPage = lazy(() => import('./components/DashboardPage'));
const MatrixView = lazy(() => import('./components/MatrixView'));
const SyncLogPage = lazy(() => import('./components/SyncLogPage'));
const UsersPage = lazy(() => import('./components/UsersPage'));
const GroupsPage = lazy(() => import('./components/GroupsPage')); // Now renders ResourcesPage
const AccessPackagesPage = lazy(() => import('./components/AccessPackagesPage'));
const UserDetailPage = lazy(() => import('./components/UserDetailPage'));
const GroupDetailPage = lazy(() => import('./components/GroupDetailPage'));
const ResourceDetailPage = lazy(() => import('./components/ResourceDetailPage'));
const AccessPackageDetailPage = lazy(() => import('./components/AccessPackageDetailPage'));
const SystemsPage = lazy(() => import('./components/SystemsPage'));
const RiskScoringPage = lazy(() => import('./components/RiskScoringPage'));
const OrgChartPage = lazy(() => import('./components/OrgChartPage'));
const DepartmentDetailPage = lazy(() => import('./components/DepartmentDetailPage'));
const ContextDetailPage = lazy(() => import('./components/ContextDetailPage'));
const IdentitiesPage = lazy(() => import('./components/IdentitiesPage'));
const IdentityDetailPage = lazy(() => import('./components/IdentityDetailPage'));
const AdminPage = lazy(() => import('./components/AdminPage'));
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

function parseMatrixParams(params) {
  const limit = params.has('limit') ? (parseInt(params.get('limit')) || 0) : 25;
  const filters = [];
  for (const [key, value] of params.entries()) {
    if (key.startsWith('f.')) {
      filters.push({ field: key.slice(2), value });
    }
  }
  const managed = params.get('managed') || 'all';
  const search = params.get('q') || '';
  return { limit, filters, managed, search };
}

function buildMatrixHash(state) {
  const params = new URLSearchParams();
  if (state.limit > 0) params.set('limit', String(state.limit));
  if (state.limit === 0) params.set('limit', '0');
  for (const f of state.filters || []) {
    params.set(`f.${f.field}`, f.value);
  }
  if (state.managed && state.managed !== 'all') params.set('managed', state.managed);
  if (state.search) params.set('q', state.search);
  const qs = params.toString();
  return `matrix${qs ? '?' + qs : ''}`;
}

export function buildMatrixUrl(state) {
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

const ALL_NAV_TABS = [
  { key: 'dashboard',        label: 'Dashboard' },
  { key: 'matrix',           label: 'Matrix' },
  { key: 'users',            label: 'Users' },
  { key: 'resources',        label: 'Resources' },
  { key: 'systems',          label: 'Systems' },
  { key: 'access-packages',  label: 'Business Roles' },
  { key: 'sync-log',         label: 'Sync Log' },
  { key: 'risk-scores',      label: 'Risk Scores',  feature: 'riskScoring',        optional: true },
  { key: 'identities',       label: 'Identities',   feature: 'accountCorrelation', optional: true },
  { key: 'org-chart',        label: 'Org Chart',                                    optional: true },
  { key: 'admin',            label: 'Admin' },
];

export default function App() {
  // Parse initial state from URL (runs once)
  const initial = useMemo(() => {
    const { page, params } = parseHash();
    if (page === 'matrix') return parseMatrixParams(params);
    return { limit: 25, filters: [], managed: 'all', search: '' };
  }, []);

  // All shareable matrix state lives here
  const [userLimit, setUserLimit] = useState(initial.limit);
  const [activeFilters, setActiveFilters] = useState(initial.filters);
  const [managedFilter, setManagedFilter] = useState(initial.managed);
  const [filterText, setFilterText] = useState(initial.search);

  const { data, totalUsers, accessPackageGroups, managedByPackages, userColumns, groupTagMap, loading, refreshing, error, forceRefresh } = usePermissions(userLimit, activeFilters);
  const { account, logout, authFetch } = useAuth();
  const [page, navigate] = useHashRoute();
  const [moduleVersion, setModuleVersion] = useState(null);
  const [features, setFeatures] = useState({ riskScoring: true, accountCorrelation: true });
  const [visibleTabs, setVisibleTabs] = useState(null); // null = loading, [] = loaded
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(null);
  const [riskScoresRefreshKey, setRiskScoresRefreshKey] = useState(0);

  const navTabs = useMemo(() =>
    ALL_NAV_TABS.filter(tab => {
      if (tab.feature && !features[tab.feature]) return false;
      if (tab.optional && visibleTabs && !visibleTabs.includes(tab.key)) return false;
      return true;
    }),
    [features, visibleTabs]
  );

  // Available optional tabs (respecting feature flags)
  const optionalTabs = useMemo(() =>
    ALL_NAV_TABS.filter(tab => tab.optional && (!tab.feature || features[tab.feature])),
    [features]
  );

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
  const [detailTabs, setDetailTabs] = useState(() => {
    // Restore detail tab from URL on load (e.g., bookmarked #user:abc)
    const { page: initPage } = parseHash();
    if (initPage.startsWith('user:') || initPage.startsWith('group:') || initPage.startsWith('resource:') || initPage.startsWith('access-package:') || initPage.startsWith('department:') || initPage.startsWith('context:') || initPage.startsWith('identity:')) {
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
        navigate(closing?.returnPage ?? (type === 'department' || type === 'context' ? 'org-chart' : type === 'identity' ? 'identities' : type === 'resource' ? 'resources' : 'matrix'));
      }
      return remaining;
    });
    delete detailCacheRef.current[tabKey];
  }, [navigate]);

  // When navigating to a detail tab via URL that isn't tracked yet, add it
  useEffect(() => {
    if (page.startsWith('user:') || page.startsWith('group:') || page.startsWith('resource:') || page.startsWith('access-package:') || page.startsWith('department:') || page.startsWith('context:') || page.startsWith('identity:')) {
      const sepIdx = page.indexOf(':');
      const type = page.substring(0, sepIdx);
      const id = page.substring(sepIdx + 1);
      setDetailTabs(prev => {
        if (prev.some(t => t.type === type && t.id === id)) return prev;
        return [...prev, { type, id, displayName: id }];
      });
    }
  }, [page]);

  // When navigating TO the matrix tab with no data yet, re-fetch so demo data
  // loaded on the Dashboard shows up without requiring a manual slider nudge.
  const prevPageRef = useRef(null);
  useEffect(() => {
    if (page === 'matrix' && prevPageRef.current !== 'matrix' && data.length === 0 && !loading) {
      forceRefresh();
    }
    prevPageRef.current = page;
  }, [page, data.length, loading, forceRefresh]);

  // Sync URL when on matrix page (debounced replaceState — no history entry)
  useEffect(() => {
    if (page !== 'matrix') return;
    const timer = setTimeout(() => {
      const newHash = buildMatrixHash({
        limit: userLimit,
        filters: activeFilters,
        managed: managedFilter,
        search: filterText,
      });
      if (window.location.hash !== '#' + newHash) {
        history.replaceState(null, '', '#' + newHash);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [page, userLimit, activeFilters, managedFilter, filterText]);

  // Build shareable URL (stable reference for children)
  const shareUrl = useMemo(() => buildMatrixUrl({
    limit: userLimit,
    filters: activeFilters,
    managed: managedFilter,
    search: filterText,
  }), [userLimit, activeFilters, managedFilter, filterText]);

  // Check if current page is a detail tab
  const isDetailPage = page.startsWith('user:') || page.startsWith('group:') || page.startsWith('resource:') || page.startsWith('access-package:') || page.startsWith('department:') || page.startsWith('context:') || page.startsWith('identity:');

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md">
          <h2 className="text-red-800 font-semibold text-lg">Backend not responding</h2>
          <p className="text-red-600 mt-2 text-sm">{error}</p>
          <p className="text-red-500 mt-2 text-xs">
            If a crawler is currently running, this page may be temporarily slow — wait a moment and refresh.
            Otherwise check that the web container is running: <code className="bg-red-100 px-1 rounded">docker compose ps web</code> · <code className="bg-red-100 px-1 rounded">docker compose logs web</code>
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
      return <AccessPackageDetailPage key={cacheKey} accessPackageId={id} cachedData={detailCacheRef.current[cacheKey]} onCacheData={onCacheData} onClose={() => closeDetailTab('access-package', id)} />;
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
    return null;
  };

  return (
    <ErrorBoundary>
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="Identity Atlas" className="h-10 w-10" />
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Identity <span style={{ color: '#65b425' }}>Atlas</span></h1>
              <p className="text-xs text-gray-500">
                Universal authorization intelligence
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 relative" ref={settingsRef}>
            <button
              onClick={() => setSettingsOpen(prev => !prev)}
              className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
              title="Settings"
            >
              <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold">
                {(account?.name || account?.username || '?')[0].toUpperCase()}
              </div>
              <span className="hidden sm:inline">{account?.name || account?.username || 'User'}</span>
              <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${settingsOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {settingsOpen && (
              <div className="absolute right-0 top-full mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
                {/* User info */}
                <div className="px-4 py-3 border-b border-gray-100">
                  <p className="text-sm font-medium text-gray-900">{account?.name || 'User'}</p>
                  {account?.username && <p className="text-xs text-gray-500">{account.username}</p>}
                </div>

                {/* Tab visibility toggles */}
                <div className="px-4 py-3 border-b border-gray-100">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Visible Tabs</p>
                  {optionalTabs.map(tab => (
                    <label key={tab.key} className="flex items-center justify-between py-1.5 cursor-pointer group">
                      <span className="text-sm text-gray-700 group-hover:text-gray-900">{tab.label}</span>
                      <button
                        onClick={() => toggleTab(tab.key)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          visibleTabs?.includes(tab.key) ? 'bg-blue-500' : 'bg-gray-300'
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
                      className="text-sm text-gray-500 hover:text-gray-700 w-full text-left py-1"
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
                  ? 'bg-gray-50 text-blue-600 border-gray-200'
                  : 'bg-transparent text-gray-500 border-transparent hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {tab.label}
            </button>
          ))}

          {/* Dynamic detail tabs */}
          {detailTabs.map(tab => {
            const tabKey = `${tab.type}:${tab.id}`;
            const isActive = page === tabKey;
            const icon = tab.type === 'user' ? 'U' : tab.type === 'resource' ? 'R' : tab.type === 'group' ? 'G' : tab.type === 'department' ? 'D' : tab.type === 'context' ? 'OU' : 'AP';
            const iconBg = tab.type === 'user' ? 'bg-blue-100 text-blue-700' : tab.type === 'resource' ? 'bg-purple-100 text-purple-700' : tab.type === 'group' ? 'bg-purple-100 text-purple-700' : tab.type === 'department' ? 'bg-green-100 text-green-700' : tab.type === 'context' ? 'bg-sky-100 text-sky-700' : 'bg-indigo-100 text-indigo-700';
            return (
              <button
                key={tabKey}
                onClick={() => navigate(tabKey)}
                className={`group flex items-center gap-1.5 pl-2 pr-1 py-2 text-sm font-medium rounded-t-lg border border-b-0 transition-colors whitespace-nowrap max-w-[200px] ${
                  isActive
                    ? 'bg-gray-50 text-blue-600 border-gray-200'
                    : 'bg-transparent text-gray-500 border-transparent hover:text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span className={`inline-flex items-center justify-center w-4 h-4 rounded-sm text-[9px] font-bold ${iconBg}`}>{icon}</span>
                <span className="truncate max-w-[140px]">{tab.displayName}</span>
                <span
                  onClick={(e) => { e.stopPropagation(); closeDetailTab(tab.type, tab.id); }}
                  className="ml-0.5 p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"
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
      <main className="p-6">
        <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading...</div></div>}>
          {isDetailPage ? (
            renderDetailPage()
          ) : page === 'dashboard' ? (
            <DashboardPage onNavigate={navigate} />
          ) : page === 'sync-log' ? (
            <SyncLogPage />
          ) : page === 'users' ? (
            <UsersPage onOpenDetail={openDetailTab} />
          ) : page === 'resources' || page === 'groups' ? (
            <GroupsPage onOpenDetail={openDetailTab} />
          ) : page === 'systems' ? (
            <SystemsPage />
          ) : page === 'access-packages' ? (
            <AccessPackagesPage onOpenDetail={openDetailTab} />
          ) : page === 'risk-scores' ? (
            <RiskScoringPage key={riskScoresRefreshKey} onOpenDetail={openDetailTab} />
          ) : page === 'identities' ? (
            <IdentitiesPage onOpenDetail={openDetailTab} />
          ) : page === 'org-chart' ? (
            <OrgChartPage onOpenDetail={openDetailTab} onCacheData={onCacheData} />
          ) : page === 'performance' || page === 'crawlers' || page === 'admin' ? (
            // Crawlers and Performance now live under Admin as sub-tabs.
            // Legacy #crawlers and #performance hashes redirect to the matching sub-tab.
            <AdminPage onNavigate={navigate} onRefresh={forceRefresh} onRiskScoresRefresh={() => setRiskScoresRefreshKey(k => k + 1)} />
          ) : loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-500">Loading permission data...</div>
            </div>
          ) : (
            <MatrixView
              data={data}
              accessPackageGroups={accessPackageGroups}
              managedByPackages={managedByPackages}
              totalUsers={totalUsers}
              userLimit={userLimit}
              setUserLimit={setUserLimit}
              activeFilters={activeFilters}
              setActiveFilters={setActiveFilters}
              managedFilter={managedFilter}
              setManagedFilter={setManagedFilter}
              filterText={filterText}
              setFilterText={setFilterText}
              userColumns={userColumns}
              groupTagMap={groupTagMap}
              refreshing={refreshing}
              shareUrl={shareUrl}
              onOpenDetail={openDetailTab}
            />
          )}
        </Suspense>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white px-6 py-2 text-xs text-gray-400 text-center flex items-center justify-center gap-2">
        <button
          onClick={() => navigate('admin?sub=about')}
          className="hover:text-gray-600 hover:underline focus:outline-none"
        >
          Identity Atlas{moduleVersion ? ` v${moduleVersion}` : ''}
        </button>
        {/^\d+\.\d+\.\d{8}\.\d{4}$/.test(moduleVersion) && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-700 border border-amber-300">
            edge
          </span>
        )}
      </footer>
    </div>
    </ErrorBoundary>
  );
}
