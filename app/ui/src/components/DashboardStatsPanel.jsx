// Identity Atlas — "Loaded data" stats panel for the dashboard.
//
// Owns the right-hand column of the dashboard grid: the header + last-sync
// stamp, the loading / load-error / empty-database / populated switch, the
// entity-count StatCards, and the sync-log footer link. Extracted from
// DashboardPage so its state-machine and per-card branches live in small,
// single-responsibility units.

import { formatCompactNumber as formatNumber, formatRelativeTime } from '@ui/utils/formatters';

export default function StatsPanel({ stats, loading, error, hasData, reload, onNavigate }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-6 shadow-lg ring-1 ring-gray-200 dark:ring-gray-700">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xs font-bold text-lime-700 uppercase tracking-widest">Loaded data</h2>
        {hasData && (
          <span className="text-xs text-gray-600 dark:text-gray-500">
            Last sync <span className="text-gray-700 dark:text-gray-300">{formatRelativeTime(stats.lastSyncAt)}</span>
          </span>
        )}
      </div>
      <StatsPanelBody stats={stats} loading={loading} error={error} hasData={hasData} reload={reload} onNavigate={onNavigate} />
    </div>
  );
}

// The loading/error/empty/populated switch. Early returns keep each state a
// flat, independently-covered branch (rendered by the dashboard's mount tests).
function StatsPanelBody({ stats, loading, error, hasData, reload, onNavigate }) {
  if (loading) return <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>;
  if (error) return <StatsErrorState reload={reload} />;
  if (!hasData) return <NoDataState onNavigate={onNavigate} />;
  return <StatsGrid stats={stats} onNavigate={onNavigate} />;
}

// A failed stats fetch — deliberately distinct from the empty-database state so
// a load error never shows the onboarding CTA.
function StatsErrorState({ reload }) {
  return (
    <div className="rounded-lg border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-6 text-center">
      <h3 className="mb-1 text-base font-semibold text-red-800 dark:text-red-300">Couldn&apos;t load the dashboard</h3>
      <p className="mx-auto mb-4 max-w-md text-sm text-red-700 dark:text-red-400">
        There was a problem reaching the server. This is a load error — not an empty database, so your data is safe.
      </p>
      <button
        type="button"
        onClick={reload}
        className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
      >
        Retry
      </button>
    </div>
  );
}

// Populated state: the entity-count grid plus the sync-log footer link.
function StatsGrid({ stats, onNavigate }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Systems"        value={stats.systems}       onClick={() => onNavigate?.('systems')} />
        <StatCard label="Principals"     value={stats.principals}    onClick={() => onNavigate?.('principals')} />
        <StatCard label="Resources"      value={stats.resources}     onClick={() => onNavigate?.('resources')} />
        <StatCard label="Business Roles" value={stats.businessRoles} onClick={() => onNavigate?.('access-packages')} />
        <StatCard label="Identities"     value={stats.identities}    onClick={() => onNavigate?.('identities')} />
        <StatCard label="Contexts"       value={stats.contexts}      onClick={() => onNavigate?.('contexts')} />
        <StatCard label="Assignments"      value={stats.assignments}     />
        <StatCard label="Relationships"    value={stats.relationships}  />
        <StatCard label="Identity Members" value={stats.identityMembers} onClick={() => onNavigate?.('identities')} />
      </div>
      <div className="mt-5 pt-4 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-500 text-right">
        <button
          onClick={() => onNavigate?.('sync-log')}
          className="hover:text-lime-700 hover:underline transition-colors"
        >
          {stats.syncLogEntries || 0} sync log entries
        </button>
      </div>
    </>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────
function StatCard({ label, value, onClick }) {
  const clickable = typeof onClick === 'function' && value > 0;
  const empty = !value;
  return (
    <div
      onClick={clickable ? onClick : undefined}
      className={`p-3 rounded-xl transition-all ${
        clickable
          ? 'cursor-pointer bg-white dark:bg-gray-800 ring-1 ring-lime-200 dark:ring-lime-700/50 hover:ring-lime-500 dark:hover:ring-lime-600 hover:shadow-md hover:-translate-y-0.5'
          : empty
            ? 'bg-gray-50 dark:bg-gray-700/50 ring-1 ring-gray-100 dark:ring-gray-600'
            : 'bg-white dark:bg-gray-800 ring-1 ring-lime-200 dark:ring-lime-700/50'
      }`}
    >
      <div className={`text-2xl font-bold tabular-nums ${empty ? 'text-gray-600 dark:text-gray-500' : 'text-gray-900 dark:text-white'}`}>
        {formatNumber(value)}
      </div>
      <div className={`text-xs mt-0.5 font-medium ${empty ? 'text-gray-600 dark:text-gray-500' : 'text-lime-700'}`}>
        {label}
      </div>
    </div>
  );
}

// ─── NoDataState ──────────────────────────────────────────────────────
function NoDataState({ onNavigate }) {
  return (
    <div className="text-center py-8">
      <div className="text-5xl mb-3">📦</div>
      <div className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        No data loaded yet.
      </div>
      <button
        onClick={() => onNavigate?.('admin')}
        className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700"
      >
        Configure a crawler →
      </button>
      <div className="mt-3 text-xs text-gray-600 dark:text-gray-500">
        Connect Entra ID, upload CSV exports, or click "Load Demo Data" in Admin → Crawlers.
      </div>
    </div>
  );
}
