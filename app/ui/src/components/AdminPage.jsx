import { useState, useEffect, lazy, Suspense } from 'react';

import { useAuth } from '@ui/auth/AuthGate';
import { hasPermission } from '@ui/auth/usePermissions';

import { ADMIN_TABS, visibleAdminTabs } from './admin/adminTabs';

// Lazy-load the heavy sub-tab pages so they don't bloat the initial Admin bundle
const CrawlersPage = lazy(() => import('./CrawlersPage'));
const PluginsPage = lazy(() => import('./PluginsPage'));
const AuthSettingsPage = lazy(() => import('./AuthSettingsPage'));
const RolesPermissionsSection = lazy(() => import('./RolesPermissionsSection'));
const PerfPage = lazy(() => import('./PerfPage'));
const AboutPage = lazy(() => import('./AboutPage'));
const AccountLinkingSettings = lazy(() => import('./AccountLinkingSettings'));
const UpdatesSettings = lazy(() => import('./UpdatesSettings'));

import PowerQueryExportSection from './admin/PowerQueryExportSection';
import CuratedDataSection from './admin/CuratedDataSection';
import HistoryRetentionSection from './admin/HistoryRetentionSection';
import DangerZoneSection from './admin/DangerZoneSection';
import LLMSettingsSection from './admin/LLMSettingsSection';
import RiskScoringSection from './admin/RiskScoringSection';

function AdminSubTabs({ activeTab, onTabChange, tabs }) {
  return (
    <div className="border-b border-gray-200 dark:border-gray-700 mb-4">
      <nav className="flex gap-1 -mb-px" data-testid="admin-subtabs">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-blue-600 text-blue-700 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function AdminPage({ onNavigate, onRefresh, onRiskScoresRefresh }) {
  // Persist active sub-tab in URL hash like #admin?sub=crawlers so deep links work.
  // Also handles legacy #crawlers and #performance hashes by mapping them to the
  // corresponding sub-tab.
  const getInitialTab = () => {
    const hash = window.location.hash.replace('#', '');
    const page = hash.split('?')[0];
    if (page === 'crawlers') return 'crawlers';
    if (page === 'performance') return 'performance';
    // Parse query parameters properly using URLSearchParams (consistent with App.jsx parseHash())
    const qIndex = hash.indexOf('?');
    const params = new URLSearchParams(qIndex >= 0 ? hash.substring(qIndex + 1) : '');
    const sub = params.get('sub');
    return sub && ADMIN_TABS.some(t => t.key === sub) ? sub : 'crawlers';
  };
  const [activeTab, setActiveTab] = useState(getInitialTab);

  // hasWildcard + permissions come from AuthContext (populated by AuthGateProvider
  // after sign-in via /api/auth-me). Sub-tab visibility is permission-driven only:
  // the Authentication tab hosts Roles & Permissions, so it must stay reachable
  // for admins on every platform. Platform-specific guidance (the Docker CLI
  // walkthrough) is hidden inside AuthSettingsPage, not by dropping the whole tab.
  const { hasWildcard, permissions } = useAuth();
  const visibleTabs = visibleAdminTabs(permissions, hasWildcard);

  // Data-tab section gating. The Data tab is reachable if the user has ANY of
  // its permissions (adminTabs `requires`), but each section is a distinct
  // action with its own server-side gate — so render each only for the user
  // who can actually use it, instead of showing controls that 403 on click.
  // Mirrors the server: dataExport.js (workbook=data.export.ui, read-tokens=
  // data.export.apikey/admin.read-tokens), curatedData.js (export=data.export.ui,
  // import=admin.csv-import), maintenance.js (retention + clean=admin.systems).
  const canPowerQuery = hasPermission(permissions, hasWildcard, 'data.export.ui', 'data.export.apikey', 'admin.read-tokens');
  const canCuratedData = hasPermission(permissions, hasWildcard, 'data.export.ui', 'admin.csv-import');
  const canManageSystems = hasPermission(permissions, hasWildcard, 'admin.systems');

  // If the user was on a now-hidden tab, bounce them to the first visible one.
  // Done during render — setting to a guaranteed-visible tab converges on the
  // next render, so it doesn't trip react-hooks/set-state-in-effect.
  if (visibleTabs.length && !visibleTabs.some(t => t.key === activeTab)) {
    setActiveTab(visibleTabs[0]?.key || 'crawlers');
  }

  useEffect(() => {
    // Update the hash when the user changes sub-tab so reloads land in the same place.
    // Also rewrite legacy #crawlers / #performance to #admin?sub=...
    const hash = window.location.hash.replace('#', '');
    const page = hash.split('?')[0];
    const isLegacy = page === 'crawlers' || page === 'performance';
    const newHash = `#admin?sub=${activeTab}`;
    if (isLegacy || !window.location.hash.includes(`sub=${activeTab}`)) {
      window.history.replaceState(null, '', newHash);
    }
  }, [activeTab]);

  // Listen for hash changes (e.g. clicking version link from footer) and update activeTab
  useEffect(() => {
    const handleHashChange = () => {
      setActiveTab(getInitialTab());
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []); // Only register once on mount - React bails out if state value unchanged

  const currentTab = visibleTabs.find(t => t.key === activeTab) || visibleTabs[0];

  // Lazy-loaded tabs render identically — one Suspense wrapper over a lookup,
  // rather than a per-tab `activeTab === 'x' && <Suspense>…` block each (which
  // both duplicated the wrapper and pushed this component over the complexity
  // ceiling). Prop-carrying and non-lazy tabs stay explicit below.
  const lazyTabContent = {
    crawlers: () => <CrawlersPage onNavigate={onNavigate} />,
    plugins: () => <PluginsPage onNavigate={onNavigate} />,
    'account-linking': () => <AccountLinkingSettings />,
    performance: () => <PerfPage />,
    auth: () => <AuthSettingsPage />,
    roles: () => <RolesPermissionsSection />,
    updates: () => <UpdatesSettings />,
    about: () => <AboutPage />,
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-3 px-2">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Admin</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{currentTab.description}</p>
        </div>
      </div>

      <AdminSubTabs activeTab={activeTab} onTabChange={setActiveTab} tabs={visibleTabs} />

      <div className="space-y-4 px-2">
        {lazyTabContent[activeTab] && (
          <Suspense fallback={<div className="text-sm text-gray-500 dark:text-gray-400 p-6">Loading…</div>}>
            {lazyTabContent[activeTab]()}
          </Suspense>
        )}

        {activeTab === 'data' && (
          <>
            {canPowerQuery && <PowerQueryExportSection />}
            {canCuratedData && <CuratedDataSection />}
            {canManageSystems && <HistoryRetentionSection />}
            {canManageSystems && <DangerZoneSection onRefresh={onRefresh} />}
          </>
        )}

        {activeTab === 'risk-scoring' && <RiskScoringSection onRiskScoresRefresh={onRiskScoresRefresh} />}
        {activeTab === 'llm' && <LLMSettingsSection />}
      </div>
    </div>
  );
}
