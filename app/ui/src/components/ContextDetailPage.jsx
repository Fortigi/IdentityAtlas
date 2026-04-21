import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection from './RiskScoreSection';
import { variantMeta, targetTypeMeta } from '../utils/contextStyles';

// ─── Context Detail Page ──────────────────────────────────────────────────────
// Shows details for a single Context (v6 shape): header with variant /
// target / scope-system / owner, paginated members, sub-contexts.
// Loaded via /api/contexts/:id.

const SYSTEM_COLS = new Set([
  'SysStartTime', 'SysEndTime', 'ValidFrom', 'ValidTo',
  // New-shape fields already surfaced in the header — don't repeat in the
  // attributes grid.
  'id', 'variant', 'targetType', 'contextType', 'displayName', 'description',
  'parentContextId', 'scopeSystemId', 'scopeSystemName', 'sourceAlgorithmId',
  'sourceAlgorithmName', 'sourceAlgorithmDisplayName', 'sourceRunId',
  'createdByUser', 'ownerUserId', 'externalId', 'parentDisplayName',
]);

function cleanAttributes(attrs) {
  if (!attrs) return {};
  const clean = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!SYSTEM_COLS.has(key) && value != null && value !== '') {
      clean[key] = value;
    }
  }
  return clean;
}

export default function ContextDetailPage({ contextId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);

  // Paginated members
  const [memberPage, setMemberPage] = useState(0);
  const [memberSearch, setMemberSearch] = useState('');
  const [members, setMembers] = useState([]);
  const [memberTotal, setMemberTotal] = useState(0);
  const [membersLoading, setMembersLoading] = useState(false);
  const [riskData, setRiskData] = useState(null);
  const PAGE_SIZE = 50;

  // ─── Fetch risk score data ──────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/risk-scores/contexts/${contextId}`);
        if (res.ok) setRiskData(await res.json());
      } catch { /* risk data optional */ }
    })();
  }, [authFetch, contextId]);

  // ─── Fetch Context detail ──────────────────────────────────────────
  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/contexts/${contextId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDetail(data);
      if (onCacheData) onCacheData(contextId, 'context', data);
    } catch (err) {
      console.error('Failed to load context detail:', err);
      setError(err.message || 'Failed to load context details');
    } finally {
      setLoading(false);
    }
  }, [authFetch, contextId, onCacheData]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  // ─── Fetch paginated members ──────────────────────────────────────
  const fetchMembers = useCallback(async () => {
    setMembersLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(memberPage * PAGE_SIZE),
      });
      if (memberSearch) params.set('search', memberSearch);
      const res = await authFetch(`/api/contexts/${contextId}/members?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMembers(data.data || []);
      setMemberTotal(data.total || 0);
    } catch (err) {
      console.error('Failed to load context members:', err);
    } finally {
      setMembersLoading(false);
    }
  }, [authFetch, contextId, memberPage, memberSearch]);

  useEffect(() => { fetchMembers(); }, [fetchMembers]);

  // Reset page when search changes
  useEffect(() => { setMemberPage(0); }, [memberSearch]);

  // ─── Render ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading context details...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md mx-auto mt-12">
        <h2 className="text-red-800 font-semibold text-lg">Failed to load context</h2>
        <p className="text-red-600 mt-2 text-sm">{error}</p>
        <div className="flex gap-3 mt-3">
          <button onClick={fetchDetail} className="text-sm text-red-700 underline hover:text-red-900">Retry</button>
          <button onClick={onClose} className="text-sm text-gray-500 underline hover:text-gray-700">Close</button>
        </div>
      </div>
    );
  }

  if (!detail || !detail.attributes) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-400 text-sm">
        Context not found.
        <button onClick={onClose} className="ml-2 text-blue-500 underline hover:text-blue-700">Close</button>
      </div>
    );
  }

  const attrs = cleanAttributes(detail.attributes);
  const subContexts = detail.subContexts || [];
  const totalPages = Math.ceil(memberTotal / PAGE_SIZE);

  return (
    <div className="space-y-6">
      {/* Header */}
      <ContextHeader attrs={detail.attributes} onClose={onClose} />
      {detail.attributes.description && (
        <div className="bg-white border border-gray-200 rounded-lg px-6 py-3 text-sm text-gray-700">{detail.attributes.description}</div>
      )}

      {/* Risk Score */}
      {riskData && <RiskScoreSection attributes={riskData} entityType="contexts" entityId={contextId} authFetch={authFetch} />}

      {/* Sub-contexts */}
      {subContexts.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            Sub-contexts ({subContexts.length})
          </h3>
          <div className="space-y-1">
            {subContexts.map(sc => (
              <button
                key={sc.id}
                onClick={() => onOpenDetail('context', sc.id, sc.displayName)}
                className="w-full text-left flex items-center justify-between px-3 py-2 rounded hover:bg-sky-50 transition-colors group"
              >
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-sky-100 text-sky-700 text-[9px] font-bold">CTX</span>
                  <span className="text-sm text-gray-900 group-hover:text-sky-700">{sc.displayName}</span>
                </div>
                {sc.memberCount != null && (
                  <span className="text-xs text-gray-400">{sc.memberCount} members</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Attributes JSON (non-header fields) */}
      {Object.keys(attrs).length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Attributes</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
            {Object.entries(attrs).map(([key, value]) => (
              <div key={key} className="flex items-baseline gap-2 py-1">
                <span className="text-xs text-gray-500 font-medium min-w-[140px]">{key}</span>
                <span className="text-sm text-gray-900 break-all">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Members */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">
            Members ({memberTotal})
          </h3>
          <input
            type="text"
            value={memberSearch}
            onChange={e => setMemberSearch(e.target.value)}
            placeholder="Search members..."
            className="text-sm border border-gray-200 rounded-lg px-3 py-1 w-64 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:border-transparent"
            aria-label="Search members"
          />
        </div>

        {membersLoading ? (
          <div className="text-center text-gray-400 py-8 text-sm">Loading members...</div>
        ) : members.length === 0 ? (
          <div className="text-center text-gray-400 py-8 text-sm">No members found.</div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Email</th>
                  <th className="pb-2 font-medium">Job Title</th>
                  <th className="pb-2 font-medium">Type</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {members.map(m => (
                  <tr
                    key={m.id}
                    className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                    onClick={() => onOpenDetail('user', m.id, m.displayName)}
                  >
                    <td className="py-1.5 text-blue-600 hover:underline">{m.displayName}</td>
                    <td className="py-1.5 text-gray-600">{m.email || '-'}</td>
                    <td className="py-1.5 text-gray-600">{m.jobTitle || '-'}</td>
                    <td className="py-1.5">
                      {m.principalType && (
                        <span className="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">{m.principalType}</span>
                      )}
                    </td>
                    <td className="py-1.5">
                      {m.accountEnabled != null && (
                        <span className={`text-xs rounded px-1.5 py-0.5 ${m.accountEnabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {m.accountEnabled ? 'Active' : 'Disabled'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
                <button
                  onClick={() => setMemberPage(p => Math.max(0, p - 1))}
                  disabled={memberPage === 0}
                  className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-200 rounded px-2 py-1"
                >
                  Previous
                </button>
                <span className="text-xs text-gray-400">
                  Page {memberPage + 1} of {totalPages}
                </span>
                <button
                  onClick={() => setMemberPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={memberPage >= totalPages - 1}
                  className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-200 rounded px-2 py-1"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Header — surfaces provenance (variant, target, system, owner) ────────
function ContextHeader({ attrs, onClose }) {
  const v = variantMeta(attrs.variant);
  const t = targetTypeMeta(attrs.targetType);
  const provenance = describeProvenance(attrs);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 border-l-4" style={{ borderLeftColor: '' /* handled via variant dot below */ }}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`w-1.5 h-8 ${v.dotClass} rounded`} aria-hidden="true" />
            <h2 className="text-xl font-semibold text-gray-900 truncate">{attrs.displayName || attrs.id}</h2>
            {attrs.contextType && (
              <span className="text-[10px] uppercase tracking-wide text-gray-600 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5">
                {attrs.contextType}
              </span>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass}`}>{t.label}</span>
            <span className={`inline-flex items-center gap-1 text-[10px] ${v.textClass}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${v.dotClass}`} />{v.label}
            </span>
            {attrs.scopeSystemName && (
              <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                {attrs.scopeSystemName}
              </span>
            )}
            {attrs.ownerUserId && (
              <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                Owner: {attrs.ownerUserId}
              </span>
            )}
          </div>
          {provenance && <p className="text-xs text-gray-500 mt-2">{provenance}</p>}
          {attrs.parentDisplayName && (
            <p className="text-xs text-gray-500 mt-1">Parent: {attrs.parentDisplayName}</p>
          )}
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1" title="Close">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function describeProvenance(attrs) {
  if (attrs.variant === 'synced') {
    const src = attrs.scopeSystemName ? `system ${attrs.scopeSystemName}` : 'an upstream crawler';
    return `Synced from ${src}. Updated by the next crawl; analyst edits do not persist.`;
  }
  if (attrs.variant === 'generated') {
    const algo = attrs.sourceAlgorithmDisplayName || attrs.sourceAlgorithmName || 'a plugin';
    const sys = attrs.scopeSystemName ? ` on ${attrs.scopeSystemName}` : '';
    return `Generated by the "${algo}" plugin${sys}. Replaced by the next run of the same plugin.`;
  }
  if (attrs.variant === 'manual') {
    return `Created manually${attrs.createdByUser ? ` by ${attrs.createdByUser}` : ''}. Edit name, description, parent, and owner in-place.`;
  }
  return null;
}
