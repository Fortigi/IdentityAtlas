import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection from './RiskScoreSection';
import ManualContextEditor from './contexts/ManualContextEditor';
import ContextMemberPicker from './contexts/ContextMemberPicker';
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
  const [includeDescendants, setIncludeDescendants] = useState(false);
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
      if (includeDescendants) params.set('include', 'descendants');
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
  }, [authFetch, contextId, memberPage, memberSearch, includeDescendants]);

  useEffect(() => { fetchMembers(); }, [fetchMembers]);

  // Reset page when search / scope changes
  useEffect(() => { setMemberPage(0); }, [memberSearch, includeDescendants]);

  // ─── Render ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500 dark:text-gray-400 dark:text-gray-500">Loading context details...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6 max-w-md mx-auto mt-12">
        <h2 className="text-red-800 dark:text-red-300 font-semibold text-lg">Failed to load context</h2>
        <p className="text-red-600 dark:text-red-400 mt-2 text-sm">{error}</p>
        <div className="flex gap-3 mt-3">
          <button onClick={fetchDetail} className="text-sm text-red-700 dark:text-red-400 underline hover:text-red-900">Retry</button>
          <button onClick={onClose} className="text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500 underline hover:text-gray-700 dark:text-gray-300">Close</button>
        </div>
      </div>
    );
  }

  if (!detail || !detail.attributes) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-8 text-center text-gray-400 dark:text-gray-500 text-sm">
        Context not found.
        <button onClick={onClose} className="ml-2 text-blue-500 dark:text-blue-400 underline hover:text-blue-700 dark:text-blue-300">Close</button>
      </div>
    );
  }

  const attrs = cleanAttributes(detail.attributes);
  const subContexts = detail.subContexts || [];
  const totalPages = Math.ceil(memberTotal / PAGE_SIZE);
  const isManual = detail.attributes.variant === 'manual';
  const isGenerated = detail.attributes.variant === 'generated';
  // Analyst-owned membership writes work for both manual + generated
  // contexts. Synced is the only variant we refuse — the source system
  // would overwrite the analyst edit on the next crawl.
  const canEditMembers = isManual || isGenerated;

  async function removeMember(memberId) {
    try {
      const r = await authFetch(`/api/contexts/${contextId}/members/${memberId}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 204) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      fetchMembers(); fetchDetail();
    } catch (err) {
      console.error('Remove member failed:', err);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <ContextHeader attrs={detail.attributes} onClose={onClose} />
      {detail.attributes.description && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-6 py-3 text-sm text-gray-700 dark:text-gray-300">{detail.attributes.description}</div>
      )}

      {/* Manual-context inline editor */}
      {isManual && (
        <ManualContextEditor
          contextId={contextId}
          attrs={detail.attributes}
          onUpdated={() => fetchDetail()}
          onDeleted={() => onClose?.()}
        />
      )}

      {/* Generated-context actions — delete only; everything else is owned
          by the plugin that produced this row. */}
      {isGenerated && (
        <GeneratedContextActions
          contextId={contextId}
          attrs={detail.attributes}
          authFetch={authFetch}
          onDeleted={() => onClose?.()}
        />
      )}

      {/* Risk Score */}
      {riskData && <RiskScoreSection attributes={riskData} entityType="contexts" entityId={contextId} authFetch={authFetch} />}

      {/* Sub-contexts */}
      {subContexts.length > 0 && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Sub-contexts ({subContexts.length})
          </h3>
          <div className="space-y-1">
            {subContexts.map(sc => (
              <button
                key={sc.id}
                onClick={() => onOpenDetail('context', sc.id, sc.displayName)}
                className="w-full text-left flex items-center justify-between px-3 py-2 rounded hover:bg-sky-50 dark:bg-sky-900/30 transition-colors group"
              >
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-sky-100 text-sky-700 dark:text-sky-300 text-[9px] font-bold">CTX</span>
                  <span className="text-sm text-gray-900 dark:text-white group-hover:text-sky-700 dark:text-sky-300">{sc.displayName}</span>
                </div>
                {sc.memberCount != null && (
                  <span className="text-xs text-gray-400 dark:text-gray-500">{sc.memberCount} members</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Attributes JSON (non-header fields) */}
      {Object.keys(attrs).length > 0 && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Attributes</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
            {Object.entries(attrs).map(([key, value]) => (
              <div key={key} className="flex items-baseline gap-2 py-1">
                <span className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500 font-medium min-w-[140px]">{key}</span>
                <span className="text-sm text-gray-900 dark:text-white break-all">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Members */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
        <div className="flex items-center justify-between mb-3 gap-4 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Members ({memberTotal})
            {detail.attributes.totalMemberCount > (detail.attributes.directMemberCount || 0) && !includeDescendants && (
              <span className="ml-2 text-[11px] font-normal text-gray-500 dark:text-gray-400 dark:text-gray-500">
                direct only — {detail.attributes.directMemberCount || 0} of {detail.attributes.totalMemberCount} total
              </span>
            )}
          </h3>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400 dark:text-gray-500 cursor-pointer">
              <input
                type="checkbox"
                checked={includeDescendants}
                onChange={e => setIncludeDescendants(e.target.checked)}
                className="w-3.5 h-3.5"
              />
              Include sub-contexts
            </label>
            <input
              type="text"
              value={memberSearch}
              onChange={e => setMemberSearch(e.target.value)}
              placeholder="Search members..."
              className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1 w-64 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-sky-400 dark:focus:ring-sky-500 focus:border-transparent"
              aria-label="Search members"
            />
          </div>
        </div>

        {canEditMembers && (
          <div className="mb-4">
            {isGenerated && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400 dark:text-gray-500 mb-1">
                Manually-added members (<code>addedBy=analyst</code>) survive future plugin runs.
                Algorithm-produced members are replaced on every run.
              </p>
            )}
            <ContextMemberPicker
              contextId={contextId}
              targetType={detail.attributes.targetType}
              existingMemberIds={members.map(m => m.id)}
              onAdded={() => { fetchMembers(); fetchDetail(); }}
            />
          </div>
        )}

        {membersLoading ? (
          <div className="text-center text-gray-400 dark:text-gray-500 py-8 text-sm">Loading members...</div>
        ) : members.length === 0 ? (
          <div className="text-center text-gray-400 dark:text-gray-500 py-8 text-sm">No members found.</div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-700">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Email</th>
                  <th className="pb-2 font-medium">Job Title</th>
                  <th className="pb-2 font-medium">Type</th>
                  <th className="pb-2 font-medium">Status</th>
                  {canEditMembers && <th className="pb-2 font-medium"></th>}
                </tr>
              </thead>
              <tbody>
                {members.map(m => (
                  <tr
                    key={m.id}
                    className="border-b border-gray-50 hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:bg-gray-700/50 cursor-pointer"
                    onClick={() => onOpenDetail('user', m.id, m.displayName)}
                  >
                    <td className="py-1.5 text-blue-600 dark:text-blue-400 hover:underline">{m.displayName}</td>
                    <td className="py-1.5 text-gray-600 dark:text-gray-400 dark:text-gray-500">{m.email || '-'}</td>
                    <td className="py-1.5 text-gray-600 dark:text-gray-400 dark:text-gray-500">{m.jobTitle || '-'}</td>
                    <td className="py-1.5">
                      {m.principalType && (
                        <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 dark:text-gray-500 rounded px-1.5 py-0.5">{m.principalType}</span>
                      )}
                    </td>
                    <td className="py-1.5">
                      {m.accountEnabled != null && (
                        <span className={`text-xs rounded px-1.5 py-0.5 ${m.accountEnabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700 dark:text-red-400'}`}>
                          {m.accountEnabled ? 'Active' : 'Disabled'}
                        </span>
                      )}
                    </td>
                    {canEditMembers && (
                      <td className="py-1.5 text-right">
                        {includeDescendants ? (
                          <span className="text-[11px] text-gray-400 dark:text-gray-500" title="Turn off sub-context view to remove members">—</span>
                        ) : (
                          <RemoveMemberButton
                            memberRow={m}
                            onRemove={removeMember}
                            isGenerated={isGenerated}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
                <button
                  onClick={() => setMemberPage(p => Math.max(0, p - 1))}
                  disabled={memberPage === 0}
                  className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-200 dark:border-gray-700 rounded px-2 py-1"
                >
                  Previous
                </button>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  Page {memberPage + 1} of {totalPages}
                </span>
                <button
                  onClick={() => setMemberPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={memberPage >= totalPages - 1}
                  className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-200 dark:border-gray-700 rounded px-2 py-1"
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
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 border-l-4" style={{ borderLeftColor: '' /* handled via variant dot below */ }}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`w-1.5 h-8 ${v.dotClass} rounded`} aria-hidden="true" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white truncate">{attrs.displayName || attrs.id}</h2>
            {attrs.contextType && (
              <span className="text-[10px] uppercase tracking-wide text-gray-600 dark:text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5">
                {attrs.contextType}
              </span>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass}`}>{t.label}</span>
            <span className={`inline-flex items-center gap-1 text-[10px] ${v.textClass}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${v.dotClass}`} />{v.label}
            </span>
            {attrs.scopeSystemName && (
              <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-gray-700 text-slate-600 dark:text-gray-400 border border-slate-200 dark:border-gray-600">
                {attrs.scopeSystemName}
              </span>
            )}
            {attrs.ownerUserId && (
              <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-700">
                Owner: {attrs.ownerUserId}
              </span>
            )}
          </div>
          {provenance && <p className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500 mt-2">{provenance}</p>}
          {attrs.parentDisplayName && (
            <p className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500 mt-1">Parent: {attrs.parentDisplayName}</p>
          )}
        </div>
        <button onClick={onClose} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:text-gray-400 dark:text-gray-500 p-1" title="Close">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// Per-row Remove button. On a manual context, every member was added by
// an analyst and remove is final. On a generated context, members have
// addedBy='algorithm' (plugin output) or 'analyst' (manual addition);
// the remove button differentiates so the analyst knows whether the row
// will come back on the next plugin run.
function RemoveMemberButton({ memberRow, onRemove, isGenerated }) {
  const isAlgoRow = memberRow.addedBy === 'algorithm';
  if (isGenerated && isAlgoRow) {
    return (
      <button
        onClick={e => { e.stopPropagation(); onRemove(memberRow.id); }}
        className="text-[11px] text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:text-amber-300"
        title="Algorithm-produced member — removing now; the next plugin run will re-add it unless you tune plugin parameters."
      >Remove (will return)</button>
    );
  }
  return (
    <button
      onClick={e => { e.stopPropagation(); onRemove(memberRow.id); }}
      className="text-[11px] text-red-600 dark:text-red-400 hover:text-red-800 dark:text-red-300"
      title="Remove from context"
    >Remove</button>
  );
}

// ─── Generated-context actions (delete) ───────────────────────────────────
// Analysts sometimes want to prune low-signal generated trees (a cluster of
// junk, an OU that doesn't model anything useful). Deleting is permitted
// but we call out the caveat: re-running the same plugin will re-create
// the row. For persistent removal, the user should tune plugin parameters
// (e.g., add a noise token to additionalStopwords).
function GeneratedContextActions({ contextId, attrs, authFetch, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  async function doDelete() {
    setDeleting(true); setError(null);
    try {
      const r = await authFetch(`/api/contexts/${contextId}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 204) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      onDeleted?.();
    } catch (err) {
      setError(err.message || 'Delete failed');
      setDeleting(false);
    }
  }

  const algo = attrs.sourceAlgorithmDisplayName || attrs.sourceAlgorithmName || 'its plugin';

  return (
    <div className="bg-white dark:bg-gray-800 border border-sky-200 dark:border-sky-700 rounded-lg p-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Generated context — actions</h3>
        <span className="text-[10px] text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-700 rounded px-1.5 py-0.5">
          Generated by {algo}
        </span>
      </div>
      <p className="text-[11px] text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-3">
        Delete this context if it's noise. Re-running <code className="px-1 bg-gray-100 dark:bg-gray-700 rounded">{attrs.sourceAlgorithmName || 'the plugin'}</code>{' '}
        with the same parameters will recreate it — to keep it gone, also tune the plugin
        parameters (e.g., add noise tokens to <code className="px-1 bg-gray-100 dark:bg-gray-700 rounded">additionalStopwords</code>)
        before re-running.
      </p>

      {error && <div className="mb-3 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded px-2 py-1">{error}</div>}

      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-red-700 dark:text-red-400">Delete this context and all its descendants + members?</span>
          <button
            onClick={doDelete}
            disabled={deleting}
            className="px-3 py-1 text-xs rounded bg-red-600 dark:bg-red-700 text-white disabled:opacity-50 hover:bg-red-700 dark:hover:bg-red-600"
          >
            {deleting ? 'Deleting…' : 'Yes, delete'}
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="px-3 py-1 text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300"
          >Cancel</button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="text-[11px] text-red-600 dark:text-red-400 hover:text-red-700 dark:text-red-400"
        >Delete context…</button>
      )}
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
