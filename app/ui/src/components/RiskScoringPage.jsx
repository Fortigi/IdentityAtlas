import { useState, useEffect, useReducer, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useCanManageCrawlers } from '@ui/auth/usePermissions';
import { useDialog } from '@ui/components/dialogContext';
import { TIER_STYLES } from '@ui/utils/tierStyles';

// Human-readable noun for the current risk-scoring view, used in the search
// field's placeholder and its accessible label.
const VIEW_SEARCH_NOUNS = { groups: 'resources', users: 'users', 'business-roles': 'business roles', contexts: 'contexts', identities: 'identities' };
const viewSearchNoun = (view) => VIEW_SEARCH_NOUNS[view] || view;

// Total analyst overrides across every entity class in the summary.
function countOverrides(s) {
  if (!s) return 0;
  return (s.groupOverrides || 0) + (s.userOverrides || 0) + (s.businessRoleOverrides || 0)
    + (s.contextOverrides || 0) + (s.identityOverrides || 0);
}

function TierBadge({ tier }) {
  const s = TIER_STYLES[tier] || TIER_STYLES.None;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${s.bg} ${s.text} ${s.border} border`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {tier || 'None'}
    </span>
  );
}

function ScoreBar({ score, maxScore = 100 }) {
  const pct = Math.min(100, Math.max(0, (score / maxScore) * 100));
  const color = score >= 90 ? 'bg-red-400' : score >= 70 ? 'bg-orange-400' : score >= 40 ? 'bg-yellow-400' : score >= 20 ? 'bg-blue-400' : 'bg-gray-300';
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-gray-600 dark:text-gray-400 w-6 text-right">{score}</span>
    </div>
  );
}

// ─── Distribution Chart ──────────────────────────────────────────────

function DistributionChart({ label, byTier, total }) {
  const tiers = ['Critical', 'High', 'Medium', 'Low', 'Minimal', 'None'];
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">{label}</h3>
      <p className="text-xs text-gray-600 dark:text-gray-500 mb-3">{total} scored</p>
      <div className="space-y-2">
        {tiers.map(tier => {
          const count = byTier[tier] || 0;
          if (count === 0) return null;
          const pct = total > 0 ? (count / total) * 100 : 0;
          const s = TIER_STYLES[tier];
          return (
            <div key={tier} className="flex items-center gap-2">
              <span className={`w-16 text-xs font-medium ${s.text}`}>{tier}</span>
              <div className="flex-1 h-5 bg-gray-50 dark:bg-gray-700/50 rounded overflow-hidden">
                <div className={`h-full ${s.dot} rounded`} style={{ width: `${pct}%` }} />
              </div>
              <span className="w-8 text-xs text-gray-500 dark:text-gray-400 text-right">{count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Entity Table ────────────────────────────────────────────────────
//
// Rows navigate to the full detail page (UserDetailPage / ResourceDetailPage /
// AccessPackageDetailPage / etc.) when clicked. The detail page shows the
// same score breakdown this page used to show in a local modal, plus all the
// entity's attributes, memberships, and history — which is what the user
// actually wants when drilling into a flagged entity.

function EntityTable({ entities, entityType, onOpenDetail }) {
  if (!entities || entities.length === 0) {
    return <div className="py-8 text-center text-gray-600 dark:text-gray-500">No entities match the current filters</div>;
  }

  // Define extra columns per entity type
  const extraColumns = {
    user: [
      { key: 'department', label: 'Department', render: e => e.department || '\u2014' },
      { key: 'jobTitle', label: 'Title', render: e => e.jobTitle || '\u2014' },
    ],
    group: [],
    'business-role': [
      { key: 'catalogName', label: 'Catalog', render: e => e.catalogName || '\u2014' },
    ],
    'context': [
      { key: 'department', label: 'Department', render: e => e.department || '\u2014' },
      { key: 'memberCount', label: 'Members', render: e => e.memberCount ?? '\u2014' },
      { key: 'managerName', label: 'Manager', render: e => e.managerName || '\u2014' },
    ],
    identity: [
      { key: 'accountCount', label: 'Accounts', render: e => e.accountCount ?? '\u2014' },
      { key: 'department', label: 'Department', render: e => e.department || '\u2014' },
      { key: 'linkConfidence', label: 'Confidence', render: e => e.linkConfidence != null ? `${Math.round(e.linkConfidence * 100)}%` : '\u2014' },
    ],
  };

  const cols = extraColumns[entityType] || [];

  // Map entity type to detail page type for drill-through
  const detailTypeMap = { user: 'user', group: 'group', 'business-role': 'access-package', 'context': 'context', identity: 'identity' };
  const detailType = detailTypeMap[entityType] || entityType;

  const openDetail = (entity) => {
    if (onOpenDetail) onOpenDetail(detailType, entity.id, entity.displayName);
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-700">
            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Name</th>
            {cols.map(c => (
              <th key={c.key} className="text-left py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{c.label}</th>
            ))}
            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase w-20">Score</th>
            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase w-24">Tier</th>
            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Why</th>
            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase w-20">Override</th>
          </tr>
        </thead>
        <tbody>
          {entities.map(entity => {
            const matches = Array.isArray(entity.classifierMatches)
              ? entity.classifierMatches
              : (typeof entity.classifierMatches === 'string'
                  ? (() => { try { return JSON.parse(entity.classifierMatches); } catch { return []; } })()
                  : []);
            return (
              <tr
                key={entity.id}
                className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                onClick={() => openDetail(entity)}
                title="Open detail page"
              >
                <td className="py-2 px-3">
                  <span className="text-blue-600 dark:text-blue-400 hover:underline font-medium">{entity.displayName}</span>
                  {(entityType === 'group' || entityType === 'business-role') && entity.description && (
                    <p className="text-xs text-gray-600 dark:text-gray-500 truncate max-w-xs">{entity.description}</p>
                  )}
                </td>
                {cols.map(c => (
                  <td key={c.key} className="py-2 px-3 text-gray-600 dark:text-gray-400">{c.render(entity)}</td>
                ))}
                <td className="py-2 px-3">
                  <ScoreBar score={entity.effectiveScore ?? entity.riskScore} />
                </td>
                <td className="py-2 px-3"><TierBadge tier={entity.riskTier} /></td>
                <td className="py-2 px-3">
                  {matches.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {matches.slice(0, 3).map((m, i) => (
                        <span
                          key={i}
                          title={`${m.label || m.id} (${m.tier || '?'}) — score ${m.score ?? '?'}`}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 dark:text-blue-300 border border-blue-100"
                        >
                          {m.label || m.id}
                        </span>
                      ))}
                      {matches.length > 3 && (
                        <span className="text-[10px] text-gray-600 dark:text-gray-500">+{matches.length - 3}</span>
                      )}
                    </div>
                  ) : entity.riskMembershipScore > 0 ? (
                    <span className="text-[10px] text-gray-600 dark:text-gray-500">small-group bonus</span>
                  ) : (
                    <span className="text-[10px] text-gray-500">—</span>
                  )}
                </td>
                <td className="py-2 px-3">
                  {entity.riskOverride != null ? (
                    <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                      entity.riskOverride > 0 ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400' : 'bg-green-50 text-green-700'
                    }`} title={entity.riskOverrideReason}>
                      {entity.riskOverride > 0 ? '+' : ''}{entity.riskOverride}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-500">&mdash;</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Kick-off button for a scoring run. Renders nothing without the admin.crawlers
// permission — kept as its own component so the page body doesn't carry the
// canRun/running conditionals inline (keeps its cognitive complexity in check).
function RunScoringButton({ canRun, running, onRun, className }) {
  if (!canRun) return null;
  return (
    <button type="button" onClick={onRun} disabled={running} className={className}>
      {running ? 'Starting…' : 'Run scoring now'}
    </button>
  );
}

// ─── Main Risk Scoring Page ──────────────────────────────────────────

function RiskScoringHeader({ totalOverrides, scoredAt, canRun, running, onRun }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Identity Risk Scores</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Persisted risk scores computed by the risk scoring engine
          {totalOverrides > 0 && (
            <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">
              ({totalOverrides} analyst override{totalOverrides !== 1 ? 's' : ''})
            </span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {scoredAt && (
          <span className="text-xs text-gray-600 dark:text-gray-500">
            Last scored: {new Date(scoredAt).toLocaleString()}
          </span>
        )}
        <RunScoringButton
          canRun={canRun}
          running={running}
          onRun={onRun}
          className="px-3 py-1.5 rounded text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
        />
      </div>
    </div>
  );
}

function RiskUnavailable({ canRun, running, onRun }) {
  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-lg p-6 text-center">
        <h3 className="text-amber-800 dark:text-amber-300 font-semibold text-lg">Risk Scores Not Yet Computed</h3>
        <p className="text-amber-700 dark:text-amber-400 text-sm mt-2">
          Run the risk scoring engine to compute a score for every identity and resource. It can also be configured and run from <span className="font-semibold">Admin&nbsp;→&nbsp;Risk&nbsp;Scoring</span>.
        </p>
        <RunScoringButton
          canRun={canRun}
          running={running}
          onRun={onRun}
          className="mt-4 px-4 py-2 rounded text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
        />
        <p className="text-amber-600 dark:text-amber-400 text-xs mt-3">
          Scores are persisted as columns on Principals and Resources. The UI reads them directly.
        </p>
      </div>
    </div>
  );
}

function RiskDistributionRow({ s }) {
  const distCharts = [];
  if (s.totalGroups > 0) distCharts.push({ label: 'Resources', byTier: s.groupsByTier, total: s.totalGroups });
  if (s.totalUsers > 0) distCharts.push({ label: 'Users', byTier: s.usersByTier, total: s.totalUsers });
  if (s.totalBusinessRoles > 0) distCharts.push({ label: 'Business Roles', byTier: s.businessRolesByTier, total: s.totalBusinessRoles });
  if (s.totalContexts > 0) distCharts.push({ label: 'Contexts', byTier: s.contextsByTier, total: s.totalContexts });
  if (s.totalIdentities > 0) distCharts.push({ label: 'Identities', byTier: s.identitiesByTier, total: s.totalIdentities });
  const colCount = distCharts.length;
  const gridCols = colCount <= 2 ? 'grid-cols-2' : colCount <= 3 ? 'grid-cols-3' : colCount <= 4 ? 'grid-cols-4' : 'grid-cols-5';
  return (
    <div className={`grid gap-4 ${gridCols}`}>
      {distCharts.map(c => (
        <DistributionChart key={c.label} label={c.label} byTier={c.byTier} total={c.total} />
      ))}
    </div>
  );
}

// One "Top Risk …" column — both the resources and users panels share this shape.
function TopRiskList({ title, entities }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">{title}</h3>
      <div className="space-y-2">
        {(entities || []).slice(0, 5).map(e => (
          <div key={e.id} className="flex items-center justify-between">
            <span className="text-sm text-gray-800 dark:text-gray-200 truncate max-w-[60%]">{e.displayName}</span>
            <div className="flex items-center gap-2">
              <ScoreBar score={e.effectiveScore ?? e.riskScore} />
              <TierBadge tier={e.riskTier} />
              {e.riskOverride != null && (
                <span className={`text-[10px] font-mono ${e.riskOverride > 0 ? 'text-red-500' : 'text-green-500'}`}>
                  {e.riskOverride > 0 ? '+' : ''}{e.riskOverride}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TopRisksPanel({ s }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <TopRiskList title="Top Risk Resources" entities={s.topGroups} />
      <TopRiskList title="Top Risk Users" entities={s.topUsers} />
    </div>
  );
}

function RiskViewTabs({ view, setView, s }) {
  const tabs = [
    { view: 'groups', label: 'Resources', show: s?.totalGroups > 0 || !s },
    { view: 'users', label: 'Users', show: s?.totalUsers > 0 || !s },
    { view: 'business-roles', label: 'Business Roles', show: s?.totalBusinessRoles > 0 },
    { view: 'contexts', label: 'Contexts', show: s?.totalContexts > 0 },
    { view: 'identities', label: 'Identities', show: s?.totalIdentities > 0 },
  ];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <a
        href="#contexts"
        className="px-3 py-1.5 text-sm font-medium rounded-lg text-blue-600 dark:text-blue-400 hover:bg-blue-50"
        title="Resource clusters are now a generated context tree — view them on the Contexts tab."
      >
        View clusters →
      </a>
      <span className="w-px h-5 bg-gray-200" />
      {tabs.filter(t => t.show).map(t => (
        <button
          key={t.view}
          onClick={() => setView(t.view)}
          className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
            view === t.view ? 'bg-gray-900 text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function RiskFilters({ overridesOnly, setOverridesOnly, tierFilter, setTierFilter, tiers, search, setSearch, view }) {
  return (
    <div className="flex items-center gap-3">
      <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
        <input
          type="checkbox"
          checked={overridesOnly}
          onChange={e => setOverridesOnly(e.target.checked)}
          className="rounded border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white w-3.5 h-3.5"
        />
        Overrides only
      </label>

      <select
        aria-label="Filter by risk tier"
        value={tierFilter}
        onChange={e => setTierFilter(e.target.value)}
        className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-gray-700 dark:text-gray-300"
      >
        <option value="">All tiers</option>
        {tiers.map(t => <option key={t} value={t}>{t}</option>)}
      </select>

      <input
        type="text"
        aria-label={`Search ${viewSearchNoun(view)}`}
        placeholder={`Search ${viewSearchNoun(view)}...`}
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 w-52 placeholder-gray-400"
      />
    </div>
  );
}

function RiskPagination({ page, setPage, totalPages, activeTotal, pageSize }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700">
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {page * pageSize + 1}&ndash;{Math.min((page + 1) * pageSize, activeTotal)} of {activeTotal}
      </span>
      <div className="flex gap-1">
        <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
          className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-700 disabled:opacity-30 hover:bg-gray-50 dark:hover:bg-gray-700/50">Prev</button>
        <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
          className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-700 disabled:opacity-30 hover:bg-gray-50 dark:hover:bg-gray-700/50">Next</button>
      </div>
    </div>
  );
}

export default function RiskScoringPage({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const canRun = useCanManageCrawlers();
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState(null);
  // loading/error/entityLoading are flipped synchronously inside the fetch
  // effects; reducer dispatches keep that clear of set-state-in-effect.
  const [loading, setLoading] = useReducer((_, v) => v, true);
  const [error, setError] = useReducer((_, v) => v, null);
  const [view, setView] = useState('users');
  const [tierFilter, setTierFilter] = useState('');
  const [search, setSearch] = useState('');
  const [overridesOnly, setOverridesOnly] = useState(false);
  const [entityData, setEntityData] = useState({ data: [], total: 0 });
  const [entityLoading, setEntityLoading] = useReducer((_, v) => v, false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;

  // Fetch summary
  const fetchSummary = useCallback(() => {
    setLoading(true);
    return authFetch('/api/risk-scores')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setSummary(json);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [authFetch]);

  // Fetch entity list (paginated, server-side)
  const fetchEntities = useCallback(() => {
    setEntityLoading(true);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (tierFilter) params.set('tier', tierFilter);
    if (search) params.set('search', search);
    if (overridesOnly) params.set('overridesOnly', 'true');

    return authFetch(`/api/risk-scores/${view}?${params}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setEntityData(json);
      })
      .catch((err) => {
        console.error('Failed to fetch risk entities:', err);
        setEntityData({ data: [], total: 0 });
      })
      .finally(() => setEntityLoading(false));
  }, [authFetch, view, page, tierFilter, search, overridesOnly]);

  // Kick off a scoring run from this page (mirrors Admin → Risk Scoring's "Run
  // now"). Gated on admin.crawlers — the button only renders for `canRun`, and
  // the endpoint enforces the same permission server-side. Refreshes the summary
  // a few seconds later so early results appear without a manual reload.
  const runScoring = useCallback(async () => {
    setRunning(true);
    try {
      const r = await authFetch('/api/risk-scoring/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      dialog.toast('Risk scoring started — follow progress in the Logs tab.', { variant: 'success' });
      setTimeout(() => fetchSummary(), 4000);
    } catch (e) {
      dialog.alert(e.message || 'Failed to start risk scoring');
    } finally {
      setRunning(false);
    }
  }, [authFetch, dialog, fetchSummary]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);
  useEffect(() => { fetchEntities(); }, [view, fetchEntities]);
  // Reset to the first page when the filters change — during render via a
  // composite-signature compare, so no synchronous setState lives in an effect.
  const pageFilterSig = `${view}|${tierFilter}|${search}|${overridesOnly}`;
  const [seenPageFilterSig, setSeenPageFilterSig] = useState(pageFilterSig);
  if (pageFilterSig !== seenPageFilterSig) {
    setSeenPageFilterSig(pageFilterSig);
    setPage(0);
  }

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500 dark:text-gray-400">Loading risk scores...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-4">
          <h3 className="text-red-800 dark:text-red-300 font-semibold">Error</h3>
          <p className="text-red-600 dark:text-red-400 text-sm mt-1">{error}</p>
          <button onClick={fetchSummary} className="mt-3 text-sm text-red-700 dark:text-red-400 underline">Retry</button>
        </div>
      </div>
    );
  }

  if (summary && !summary.available) {
    return <RiskUnavailable canRun={canRun} running={running} onRun={runScoring} />;
  }

  const s = summary?.summary;
  const tiers = ['Critical', 'High', 'Medium', 'Low', 'Minimal', 'None'];
  const activeTotal = entityData.total || 0;
  const totalPages = Math.ceil(activeTotal / PAGE_SIZE);
  const totalOverrides = countOverrides(s);

  // Map view values to entity types for EntityTable
  const viewToEntityType = {
    groups: 'group',
    users: 'user',
    'business-roles': 'business-role',
    'contexts': 'context',
    identities: 'identity',
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <RiskScoringHeader totalOverrides={totalOverrides} scoredAt={summary?.scoredAt} canRun={canRun} running={running} onRun={runScoring} />

      {s && <RiskDistributionRow s={s} />}

      {s && <TopRisksPanel s={s} />}

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <div className="border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center justify-between gap-4">
          <RiskViewTabs view={view} setView={setView} s={s} />
          <RiskFilters
            overridesOnly={overridesOnly} setOverridesOnly={setOverridesOnly}
            tierFilter={tierFilter} setTierFilter={setTierFilter} tiers={tiers}
            search={search} setSearch={setSearch} view={view}
          />
        </div>

        {entityLoading ? (
          <div className="py-8 text-center text-gray-600 dark:text-gray-500">Loading...</div>
        ) : (
          <EntityTable
            entities={entityData.data}
            entityType={viewToEntityType[view] || 'group'}
            onOpenDetail={onOpenDetail}
          />
        )}

        <RiskPagination page={page} setPage={setPage} totalPages={totalPages} activeTotal={activeTotal} pageSize={PAGE_SIZE} />
      </div>
    </div>
  );
}
