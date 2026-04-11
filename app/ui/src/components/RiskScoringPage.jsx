import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';

// ─── Tier badge colors ───────────────────────────────────────────────
const TIER_STYLES = {
  Critical: { bg: 'bg-red-100',    text: 'text-red-800',    border: 'border-red-200',    dot: 'bg-red-500' },
  High:     { bg: 'bg-orange-100', text: 'text-orange-800', border: 'border-orange-200', dot: 'bg-orange-500' },
  Medium:   { bg: 'bg-yellow-100', text: 'text-yellow-800', border: 'border-yellow-200', dot: 'bg-yellow-500' },
  Low:      { bg: 'bg-blue-100',   text: 'text-blue-800',   border: 'border-blue-200',   dot: 'bg-blue-500' },
  Minimal:  { bg: 'bg-gray-100',   text: 'text-gray-600',   border: 'border-gray-200',   dot: 'bg-gray-400' },
  None:     { bg: 'bg-gray-50',    text: 'text-gray-400',   border: 'border-gray-100',   dot: 'bg-gray-300' },
};

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
  const color = score >= 90 ? 'bg-red-500' : score >= 70 ? 'bg-orange-500' : score >= 40 ? 'bg-yellow-500' : score >= 20 ? 'bg-blue-500' : 'bg-gray-300';
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-gray-600 w-6 text-right">{score}</span>
    </div>
  );
}

// ─── Distribution Chart ──────────────────────────────────────────────

function DistributionChart({ label, byTier, total }) {
  const tiers = ['Critical', 'High', 'Medium', 'Low', 'Minimal', 'None'];
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">{label}</h3>
      <p className="text-xs text-gray-400 mb-3">{total} scored</p>
      <div className="space-y-2">
        {tiers.map(tier => {
          const count = byTier[tier] || 0;
          if (count === 0) return null;
          const pct = total > 0 ? (count / total) * 100 : 0;
          const s = TIER_STYLES[tier];
          return (
            <div key={tier} className="flex items-center gap-2">
              <span className={`w-16 text-xs font-medium ${s.text}`}>{tier}</span>
              <div className="flex-1 h-5 bg-gray-50 rounded overflow-hidden">
                <div className={`h-full ${s.dot} rounded`} style={{ width: `${pct}%` }} />
              </div>
              <span className="w-8 text-xs text-gray-500 text-right">{count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Entity Table ────────────────────────────────────────────────────
//
// Rows navigate to the full detail page (UserDetailPage / GroupDetailPage /
// AccessPackageDetailPage / etc.) when clicked. The detail page shows the
// same score breakdown this page used to show in a local modal, plus all the
// entity's attributes, memberships, and history — which is what the user
// actually wants when drilling into a flagged entity.

function EntityTable({ entities, entityType, onOpenDetail }) {
  if (!entities || entities.length === 0) {
    return <div className="py-8 text-center text-gray-400">No entities match the current filters</div>;
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
      { key: 'correlationConfidence', label: 'Confidence', render: e => e.correlationConfidence != null ? `${Math.round(e.correlationConfidence * 100)}%` : '\u2014' },
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
          <tr className="border-b border-gray-200">
            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase">Name</th>
            {cols.map(c => (
              <th key={c.key} className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase">{c.label}</th>
            ))}
            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase w-20">Score</th>
            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase w-24">Tier</th>
            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase">Why</th>
            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase w-20">Override</th>
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
                className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                onClick={() => openDetail(entity)}
                title="Open detail page"
              >
                <td className="py-2 px-3">
                  <span className="text-blue-600 hover:underline font-medium">{entity.displayName}</span>
                  {(entityType === 'group' || entityType === 'business-role') && entity.description && (
                    <p className="text-xs text-gray-400 truncate max-w-xs">{entity.description}</p>
                  )}
                </td>
                {cols.map(c => (
                  <td key={c.key} className="py-2 px-3 text-gray-600">{c.render(entity)}</td>
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
                          className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100"
                        >
                          {m.label || m.id}
                        </span>
                      ))}
                      {matches.length > 3 && (
                        <span className="text-[10px] text-gray-400">+{matches.length - 3}</span>
                      )}
                    </div>
                  ) : entity.riskMembershipScore > 0 ? (
                    <span className="text-[10px] text-gray-400">small-group bonus</span>
                  ) : (
                    <span className="text-[10px] text-gray-300">—</span>
                  )}
                </td>
                <td className="py-2 px-3">
                  {entity.riskOverride != null ? (
                    <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                      entity.riskOverride > 0 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
                    }`} title={entity.riskOverrideReason}>
                      {entity.riskOverride > 0 ? '+' : ''}{entity.riskOverride}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-300">&mdash;</span>
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

// ─── Cluster Table ──────────────────────────────────────────────────

function ClusterTable({ clusters, onSelect, sortKey, sortDir, onSort }) {
  const SortHeader = ({ label, field, className = '' }) => {
    const active = sortKey === field;
    return (
      <th
        className={`text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700 ${className}`}
        onClick={() => onSort(field)}
      >
        {label}
        {active && <span className="ml-1 text-gray-400">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>}
      </th>
    );
  };

  if (!clusters || clusters.length === 0) {
    return <div className="py-8 text-center text-gray-400">No clusters match the current filters</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200">
            <SortHeader label="Name" field="name" />
            <SortHeader label="Type" field="type" className="w-20" />
            <SortHeader label="Members" field="members" className="w-20" />
            <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase w-24">Prod / Non</th>
            <SortHeader label="Score" field="score" className="w-20" />
            <SortHeader label="Tier" field="tier" className="w-24" />
            <SortHeader label="Owner" field="owner" />
          </tr>
        </thead>
        <tbody>
          {clusters.map(c => (
            <tr
              key={c.id}
              className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
              onClick={() => onSelect(c)}
            >
              <td className="py-2 px-3">
                <div className="font-medium text-gray-900">{c.displayName}</div>
                {c.sourceClassifierCategory && (
                  <span className="text-[10px] text-gray-400">{c.sourceClassifierCategory}</span>
                )}
              </td>
              <td className="py-2 px-3">
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                  c.clusterType === 'classifier' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'
                }`}>
                  {c.clusterType}
                </span>
              </td>
              <td className="py-2 px-3 text-xs font-mono text-gray-600">{c.memberCount}</td>
              <td className="py-2 px-3 text-xs text-gray-500">
                {c.memberCountProd}
                {c.memberCountNonProd > 0 && (
                  <span className="text-gray-400"> / {c.memberCountNonProd}</span>
                )}
              </td>
              <td className="py-2 px-3"><ScoreBar score={c.aggregateRiskScore} /></td>
              <td className="py-2 px-3"><TierBadge tier={c.riskTier} /></td>
              <td className="py-2 px-3 text-xs text-gray-500">
                {c.ownerDisplayName || <span className="text-gray-300">Unassigned</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Cluster Detail Panel ───────────────────────────────────────────

function ClusterDetail({ cluster, authFetch, onClose, onOpenDetail, onRefresh }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ownerSearch, setOwnerSearch] = useState('');
  const [ownerResults, setOwnerResults] = useState([]);
  const [showOwnerSearch, setShowOwnerSearch] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await authFetch(`/api/risk-scores/clusters/${encodeURIComponent(cluster.id)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setDetail(json);
      } catch (err) {
        console.error('Failed to load cluster detail:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authFetch, cluster.id]);

  // Search users for owner assignment
  useEffect(() => {
    if (!ownerSearch || ownerSearch.length < 2) { setOwnerResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        const res = await authFetch(`/api/risk-scores/users?search=${encodeURIComponent(ownerSearch)}&limit=8`);
        if (res.ok) {
          const json = await res.json();
          setOwnerResults(json.data || []);
        }
      } catch { }
    }, 300);
    return () => clearTimeout(timer);
  }, [authFetch, ownerSearch]);

  const handleAssignOwner = async (user) => {
    setSaving(true);
    try {
      const res = await authFetch(`/api/risk-scores/clusters/${encodeURIComponent(cluster.id)}/owner`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, displayName: user.displayName, assignedBy: 'UI' }),
      });
      if (res.ok) {
        setShowOwnerSearch(false);
        setOwnerSearch('');
        onRefresh?.();
      }
    } catch (err) {
      console.error('Failed to assign owner:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveOwner = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`/api/risk-scores/clusters/${encodeURIComponent(cluster.id)}/owner`, {
        method: 'DELETE',
      });
      if (res.ok) onRefresh?.();
    } catch (err) {
      console.error('Failed to remove owner:', err);
    } finally {
      setSaving(false);
    }
  };

  const c = detail?.cluster || cluster;
  const members = detail?.members || [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{c.displayName}</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                c.clusterType === 'classifier' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'
              }`}>{c.clusterType}</span>
              {c.sourceClassifierCategory && (
                <span className="text-xs text-gray-400">{c.sourceClassifierCategory}</span>
              )}
              <span className="text-xs text-gray-400">{c.memberCount} member{c.memberCount !== 1 ? 's' : ''}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-2xl font-bold text-gray-800">{c.aggregateRiskScore}</div>
              <TierBadge tier={c.riskTier} />
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        <div className="px-6 py-4 space-y-5">
          {/* Score summary */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-lg font-bold text-gray-800">{c.aggregateRiskScore}</div>
              <div className="text-[10px] text-gray-500">Aggregate</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-lg font-bold text-gray-800">{c.maxMemberRiskScore}</div>
              <div className="text-[10px] text-gray-500">Max</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-lg font-bold text-gray-800">{c.avgMemberRiskScore}</div>
              <div className="text-[10px] text-gray-500">Avg</div>
            </div>
          </div>

          {/* Tier distribution */}
          {c.tierDistribution && Object.keys(c.tierDistribution).length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {['Critical', 'High', 'Medium', 'Low', 'Minimal'].map(t => {
                const count = c.tierDistribution[t];
                if (!count) return null;
                const s = TIER_STYLES[t];
                return (
                  <span key={t} className={`${s.bg} ${s.text} text-xs px-2 py-0.5 rounded-full border ${s.border}`}>
                    {count} {t}
                  </span>
                );
              })}
            </div>
          )}

          {/* Owner */}
          <div className="bg-gray-50 rounded-lg p-3">
            <h4 className="text-xs font-semibold text-gray-700 mb-2">Owner / Responsible</h4>
            {c.ownerDisplayName ? (
              <div className="flex items-center justify-between">
                <div>
                  <button
                    onClick={() => c.ownerUserId && onOpenDetail?.('user', c.ownerUserId, c.ownerDisplayName)}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    {c.ownerDisplayName}
                  </button>
                  {c.ownerAssignedAt && (
                    <span className="text-[10px] text-gray-400 ml-2">
                      assigned {new Date(c.ownerAssignedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <button
                  onClick={handleRemoveOwner}
                  disabled={saving}
                  className="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-2 py-0.5 hover:bg-red-50 disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            ) : (
              <div>
                {!showOwnerSearch ? (
                  <button
                    onClick={() => setShowOwnerSearch(true)}
                    className="text-xs text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2 py-1 hover:bg-blue-50"
                  >
                    Assign Owner
                  </button>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={ownerSearch}
                      onChange={e => setOwnerSearch(e.target.value)}
                      placeholder="Search users by name..."
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 placeholder-gray-400"
                      autoFocus
                    />
                    {ownerResults.length > 0 && (
                      <div className="border border-gray-200 rounded-lg max-h-40 overflow-y-auto">
                        {ownerResults.map(u => (
                          <button
                            key={u.id}
                            onClick={() => handleAssignOwner(u)}
                            disabled={saving}
                            className="w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50 border-b border-gray-100 last:border-0 disabled:opacity-40"
                          >
                            {u.displayName}
                            {u.jobTitle && <span className="text-xs text-gray-400 ml-2">{u.jobTitle}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => { setShowOwnerSearch(false); setOwnerSearch(''); }}
                      className="text-xs text-gray-500 hover:text-gray-700"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Match patterns */}
          {c.matchPatterns && c.matchPatterns.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-700 mb-1">Match Patterns</h4>
              <div className="flex gap-1.5 flex-wrap">
                {c.matchPatterns.map((p, i) => (
                  <span key={i} className="text-[10px] font-mono bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Members */}
          <div>
            <h4 className="text-xs font-semibold text-gray-700 mb-2">
              Members ({members.length})
            </h4>
            {loading ? (
              <div className="text-xs text-gray-400 py-2">Loading members...</div>
            ) : (
              <div className="space-y-1 max-h-[300px] overflow-y-auto">
                {members.map(m => (
                  <div key={`${m.resourceType}-${m.resourceId}`} className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-gray-50">
                    <div className="flex items-center gap-2 min-w-0">
                      <button
                        onClick={() => onOpenDetail?.('group', m.resourceId, m.resourceName)}
                        className="text-sm text-blue-600 hover:underline truncate"
                      >
                        {m.resourceName}
                      </button>
                      {m.isNonProduction && (
                        <span className="text-[9px] font-medium bg-amber-50 text-amber-700 px-1 py-0.5 rounded shrink-0">NON-PROD</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <ScoreBar score={m.resourceRiskScore || 0} />
                      <TierBadge tier={m.resourceRiskTier} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Scored timestamp */}
          {c.scoredAt && (
            <div className="text-xs text-gray-400 pt-2 border-t border-gray-100">
              Scored at: {new Date(c.scoredAt).toLocaleString()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Risk Scoring Page ──────────────────────────────────────────

export default function RiskScoringPage({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState('clusters');
  const [tierFilter, setTierFilter] = useState('');
  const [search, setSearch] = useState('');
  const [overridesOnly, setOverridesOnly] = useState(false);
  const [entityData, setEntityData] = useState({ data: [], total: 0 });
  const [entityLoading, setEntityLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [clusterData, setClusterData] = useState({ available: false, data: [], total: 0 });
  const [clusterLoading, setClusterLoading] = useState(false);
  const [clusterSummary, setClusterSummary] = useState(null);
  const [selectedCluster, setSelectedCluster] = useState(null);
  const [clusterSort, setClusterSort] = useState({ key: 'score', dir: 'desc' });
  const PAGE_SIZE = 25;

  // Fetch summary
  const fetchSummary = useCallback(async () => {
    try {
      setLoading(true);
      const res = await authFetch('/api/risk-scores');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setSummary(json);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  // Fetch entity list (paginated, server-side)
  const fetchEntities = useCallback(async () => {
    try {
      setEntityLoading(true);
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (tierFilter) params.set('tier', tierFilter);
      if (search) params.set('search', search);
      if (overridesOnly) params.set('overridesOnly', 'true');

      const res = await authFetch(`/api/risk-scores/${view}?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setEntityData(json);
    } catch (err) {
      console.error('Failed to fetch risk entities:', err);
      setEntityData({ data: [], total: 0 });
    } finally {
      setEntityLoading(false);
    }
  }, [authFetch, view, page, tierFilter, search, overridesOnly]);

  // Fetch clusters (paginated, server-side)
  const fetchClusters = useCallback(async () => {
    try {
      setClusterLoading(true);
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (tierFilter) params.set('tier', tierFilter);
      if (search) params.set('search', search);
      // Build sort param: "score" (default desc) or "score-asc"
      const sortParam = clusterSort.dir === 'asc' && !['name', 'type', 'owner'].includes(clusterSort.key)
        ? `${clusterSort.key}-asc`
        : clusterSort.dir === 'desc' && ['name', 'type', 'owner'].includes(clusterSort.key)
        ? `${clusterSort.key}-desc`
        : clusterSort.key;
      params.set('sort', sortParam);
      const res = await authFetch(`/api/risk-scores/clusters?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setClusterData(json);
    } catch (err) {
      console.error('Failed to fetch clusters:', err);
      setClusterData({ available: false, data: [], total: 0 });
    } finally {
      setClusterLoading(false);
    }
  }, [authFetch, page, tierFilter, search, clusterSort]);

  // Fetch cluster summary
  const fetchClusterSummary = useCallback(async () => {
    try {
      const res = await authFetch('/api/risk-scores/cluster-summary');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setClusterSummary(json);
    } catch (err) {
      console.error('Failed to fetch cluster summary:', err);
    }
  }, [authFetch]);

  // Toggle cluster sort column
  const handleClusterSort = useCallback((field) => {
    setClusterSort(prev => {
      // Default direction: asc for text fields, desc for numeric fields
      const textFields = ['name', 'type', 'owner'];
      const defaultDir = textFields.includes(field) ? 'asc' : 'desc';
      if (prev.key === field) {
        return { key: field, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      }
      return { key: field, dir: defaultDir };
    });
    setPage(0);
  }, []);

  // Refresh clusters list after owner change
  const handleClusterRefresh = useCallback(() => {
    fetchClusters();
    fetchClusterSummary();
    setSelectedCluster(null);
  }, [fetchClusters, fetchClusterSummary]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);
  useEffect(() => { fetchClusterSummary(); }, [fetchClusterSummary]);
  useEffect(() => {
    if (view === 'clusters') fetchClusters();
    else fetchEntities();
  }, [view, fetchClusters, fetchEntities]);
  useEffect(() => { setPage(0); }, [view, tierFilter, search, overridesOnly]);

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading risk scores...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <h3 className="text-red-800 font-semibold">Error</h3>
          <p className="text-red-600 text-sm mt-1">{error}</p>
          <button onClick={fetchSummary} className="mt-3 text-sm text-red-700 underline">Retry</button>
        </div>
      </div>
    );
  }

  if (summary && !summary.available) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-center">
          <h3 className="text-amber-800 font-semibold text-lg">Risk Scores Not Yet Computed</h3>
          <p className="text-amber-700 text-sm mt-2">
            Run the risk scoring engine in PowerShell to compute scores:
          </p>
          <pre className="bg-amber-100 rounded-lg p-3 mt-3 text-sm text-amber-900 font-mono text-left inline-block">
            {`# Connect and score\nConnect-FGSQLServer -ConfigFile .\\Config\\mycompany.json\nInvoke-FGRiskScoring`}
          </pre>
          <p className="text-amber-600 text-xs mt-3">
            Scores are persisted as columns on GraphUsers and GraphGroups. The UI reads them directly.
          </p>
        </div>
      </div>
    );
  }

  const s = summary?.summary;
  const tiers = ['Critical', 'High', 'Medium', 'Low', 'Minimal', 'None'];
  const activeTotal = view === 'clusters' ? (clusterData.total || 0) : (entityData.total || 0);
  const totalPages = Math.ceil(activeTotal / PAGE_SIZE);
  const totalOverrides = (s?.groupOverrides || 0) + (s?.userOverrides || 0)
    + (s?.businessRoleOverrides || 0) + (s?.contextOverrides || 0) + (s?.identityOverrides || 0);

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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Identity Risk Scores</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Persisted risk scores computed by <code className="text-xs bg-gray-100 px-1 rounded">Invoke-FGRiskScoring</code>
            {totalOverrides > 0 && (
              <span className="ml-2 text-xs text-amber-600">
                ({totalOverrides} analyst override{totalOverrides !== 1 ? 's' : ''})
              </span>
            )}
          </p>
        </div>
        {summary?.scoredAt && (
          <span className="text-xs text-gray-400">
            Last scored: {new Date(summary.scoredAt).toLocaleString()}
          </span>
        )}
      </div>

      {/* Summary Cards */}
      {s && (() => {
        const distCharts = [];
        if (s.totalGroups > 0) distCharts.push({ label: 'Resources', byTier: s.groupsByTier, total: s.totalGroups });
        if (s.totalUsers > 0) distCharts.push({ label: 'Users', byTier: s.usersByTier, total: s.totalUsers });
        if (s.totalBusinessRoles > 0) distCharts.push({ label: 'Business Roles', byTier: s.businessRolesByTier, total: s.totalBusinessRoles });
        if (s.totalContexts > 0) distCharts.push({ label: 'Contexts', byTier: s.contextsByTier, total: s.totalContexts });
        if (s.totalIdentities > 0) distCharts.push({ label: 'Identities', byTier: s.identitiesByTier, total: s.totalIdentities });
        const hasCluster = clusterSummary?.available;
        const colCount = distCharts.length + (hasCluster ? 1 : 0);
        const gridCols = colCount <= 2 ? 'grid-cols-2' : colCount <= 3 ? 'grid-cols-3' : colCount <= 4 ? 'grid-cols-4' : 'grid-cols-5';
        return (
          <div className={`grid gap-4 ${gridCols}`}>
            {distCharts.map(c => (
              <DistributionChart key={c.label} label={c.label} byTier={c.byTier} total={c.total} />
            ))}
            {hasCluster && (
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <h3 className="text-sm font-semibold text-gray-700 mb-1">Resource Clusters</h3>
                <p className="text-xs text-gray-400 mb-3">{clusterSummary.total} clusters</p>
                <div className="space-y-2">
                  {['Critical', 'High', 'Medium', 'Low', 'Minimal'].map(tier => {
                    const count = clusterSummary.byTier?.[tier] || 0;
                    if (count === 0) return null;
                    const pct = clusterSummary.total > 0 ? (count / clusterSummary.total) * 100 : 0;
                    const st = TIER_STYLES[tier];
                    return (
                      <div key={tier} className="flex items-center gap-2">
                        <span className={`w-16 text-xs font-medium ${st.text}`}>{tier}</span>
                        <div className="flex-1 h-5 bg-gray-50 rounded overflow-hidden">
                          <div className={`h-full ${st.dot} rounded`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="w-8 text-xs text-gray-500 text-right">{count}</span>
                      </div>
                    );
                  })}
                </div>
                {clusterSummary.unowned > 0 && (
                  <p className="text-[10px] text-amber-600 mt-2">
                    {clusterSummary.unowned} cluster{clusterSummary.unowned !== 1 ? 's' : ''} without owner
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Top Risks */}
      {s && (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Top Risk Resources</h3>
            <div className="space-y-2">
              {(s.topGroups || []).slice(0, 5).map(g => (
                <div key={g.id} className="flex items-center justify-between">
                  <span className="text-sm text-gray-800 truncate max-w-[60%]">{g.displayName}</span>
                  <div className="flex items-center gap-2">
                    <ScoreBar score={g.effectiveScore ?? g.riskScore} />
                    <TierBadge tier={g.riskTier} />
                    {g.riskOverride != null && (
                      <span className={`text-[10px] font-mono ${g.riskOverride > 0 ? 'text-red-500' : 'text-green-500'}`}>
                        {g.riskOverride > 0 ? '+' : ''}{g.riskOverride}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Top Risk Users</h3>
            <div className="space-y-2">
              {(s.topUsers || []).slice(0, 5).map(u => (
                <div key={u.id} className="flex items-center justify-between">
                  <span className="text-sm text-gray-800 truncate max-w-[60%]">{u.displayName}</span>
                  <div className="flex items-center gap-2">
                    <ScoreBar score={u.effectiveScore ?? u.riskScore} />
                    <TierBadge tier={u.riskTier} />
                    {u.riskOverride != null && (
                      <span className={`text-[10px] font-mono ${u.riskOverride > 0 ? 'text-red-500' : 'text-green-500'}`}>
                        {u.riskOverride > 0 ? '+' : ''}{u.riskOverride}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Entity Tables */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setView('clusters')}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                view === 'clusters' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              Clusters
              {clusterSummary?.available && clusterSummary.total > 0 && (
                <span className="ml-1.5 text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full">
                  {clusterSummary.total}
                </span>
              )}
            </button>
            <span className="w-px h-5 bg-gray-200" />
            {(s?.totalGroups > 0 || !s) && (
              <button
                onClick={() => setView('groups')}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  view === 'groups' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                Resources
              </button>
            )}
            {(s?.totalUsers > 0 || !s) && (
              <button
                onClick={() => setView('users')}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  view === 'users' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                Users
              </button>
            )}
            {s?.totalBusinessRoles > 0 && (
              <button
                onClick={() => setView('business-roles')}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  view === 'business-roles' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                Business Roles
              </button>
            )}
            {s?.totalContexts > 0 && (
              <button
                onClick={() => setView('contexts')}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  view === 'contexts' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                Contexts
              </button>
            )}
            {s?.totalIdentities > 0 && (
              <button
                onClick={() => setView('identities')}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  view === 'identities' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                Identities
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            {view !== 'clusters' && (
              <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overridesOnly}
                  onChange={e => setOverridesOnly(e.target.checked)}
                  className="rounded border-gray-300 text-gray-900 w-3.5 h-3.5"
                />
                Overrides only
              </label>
            )}

            <select
              value={tierFilter}
              onChange={e => setTierFilter(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 text-gray-700"
            >
              <option value="">All tiers</option>
              {tiers.map(t => <option key={t} value={t}>{t}</option>)}
            </select>

            <input
              type="text"
              placeholder={`Search ${({ clusters: 'clusters', groups: 'resources', users: 'users', 'business-roles': 'business roles', 'contexts': 'contexts', identities: 'identities' })[view] || view}...`}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 w-52 placeholder-gray-400"
            />
          </div>
        </div>

        {view === 'clusters' ? (
          clusterLoading ? (
            <div className="py-8 text-center text-gray-400">Loading clusters...</div>
          ) : (
            <ClusterTable clusters={clusterData.data} onSelect={setSelectedCluster} sortKey={clusterSort.key} sortDir={clusterSort.dir} onSort={handleClusterSort} />
          )
        ) : (
          entityLoading ? (
            <div className="py-8 text-center text-gray-400">Loading...</div>
          ) : (
            <EntityTable
              entities={entityData.data}
              entityType={viewToEntityType[view] || 'group'}
              onOpenDetail={onOpenDetail}
            />
          )
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
            <span className="text-xs text-gray-500">
              {page * PAGE_SIZE + 1}&ndash;{Math.min((page + 1) * PAGE_SIZE, activeTotal)} of {activeTotal}
            </span>
            <div className="flex gap-1">
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                className="px-2 py-1 text-xs rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50">Prev</button>
              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                className="px-2 py-1 text-xs rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50">Next</button>
            </div>
          </div>
        )}
      </div>

      {selectedCluster && (
        <ClusterDetail
          cluster={selectedCluster}
          authFetch={authFetch}
          onClose={() => setSelectedCluster(null)}
          onOpenDetail={onOpenDetail}
          onRefresh={handleClusterRefresh}
        />
      )}
    </div>
  );
}
