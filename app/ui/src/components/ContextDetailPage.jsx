import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection from './RiskScoreSection';

const SYSTEM_COLS = new Set(['SysStartTime', 'SysEndTime', 'ValidFrom', 'ValidTo']);

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

  const [memberPage, setMemberPage] = useState(0);
  const [memberSearch, setMemberSearch] = useState('');
  const [members, setMembers] = useState([]);
  const [memberTotal, setMemberTotal] = useState(0);
  const [membersLoading, setMembersLoading] = useState(false);
  const [riskData, setRiskData] = useState(null);
  const PAGE_SIZE = 50;

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/risk-scores/contexts/${contextId}`);
        if (res.ok) setRiskData(await res.json());
      } catch { /* risk data optional */ }
    })();
  }, [authFetch, contextId]);

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
  useEffect(() => { setMemberPage(0); }, [memberSearch]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500 dark:text-gray-400">Loading context details...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6 max-w-md mx-auto mt-12">
        <h2 className="text-red-800 dark:text-red-300 font-semibold text-lg">Failed to load context</h2>
        <p className="text-red-600 dark:text-red-400 mt-2 text-sm">{error}</p>
        <div className="flex gap-3 mt-3">
          <button onClick={fetchDetail} className="text-sm text-red-700 dark:text-red-400 underline hover:text-red-900 dark:hover:text-red-300">Retry</button>
          <button onClick={onClose} className="text-sm text-gray-500 dark:text-gray-400 underline hover:text-gray-700 dark:hover:text-gray-300">Close</button>
        </div>
      </div>
    );
  }

  if (!detail || !detail.attributes) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-8 text-center text-gray-400 dark:text-gray-500 text-sm">
        Context not found.
        <button onClick={onClose} className="ml-2 text-blue-500 dark:text-blue-400 underline hover:text-blue-700 dark:hover:text-blue-300">Close</button>
      </div>
    );
  }

  const attrs = cleanAttributes(detail.attributes);
  const subContexts = detail.subContexts || [];
  const totalPages = Math.ceil(memberTotal / PAGE_SIZE);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 flex items-center justify-center text-sm font-bold">
                CTX
              </div>
              <div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{attrs.displayName || contextId}</h2>
                {attrs.contextType && (
                  <span className="inline-block mt-0.5 text-xs text-sky-600 dark:text-sky-300 bg-sky-50 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-700 rounded px-2 py-0.5">
                    {attrs.contextType}
                  </span>
                )}
              </div>
            </div>
            {attrs.description && (
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">{attrs.description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-1"
            title="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Risk Score */}
      {riskData && <RiskScoreSection attributes={riskData} entityType="contexts" entityId={contextId} authFetch={authFetch} />}

      {/* Attributes */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Attributes</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
          {Object.entries(attrs).map(([key, value]) => (
            <div key={key} className="flex items-baseline gap-2 py-1">
              <span className="text-xs text-gray-500 dark:text-gray-400 font-medium min-w-[140px]">{key}</span>
              <span className="text-sm text-gray-900 dark:text-gray-200 break-all">{String(value)}</span>
            </div>
          ))}
        </div>
      </div>

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
                className="w-full text-left flex items-center justify-between px-3 py-2 rounded hover:bg-sky-50 dark:hover:bg-sky-900/20 transition-colors group"
              >
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 text-[9px] font-bold">CTX</span>
                  <span className="text-sm text-gray-900 dark:text-white group-hover:text-sky-700 dark:group-hover:text-sky-300">{sc.displayName}</span>
                </div>
                {sc.memberCount != null && (
                  <span className="text-xs text-gray-400 dark:text-gray-500">{sc.memberCount} members</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Members */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Members ({memberTotal})
          </h3>
          <input
            type="text"
            value={memberSearch}
            onChange={e => setMemberSearch(e.target.value)}
            placeholder="Search members..."
            className="text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1 w-64 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:border-transparent dark:bg-gray-700 dark:text-gray-200"
            aria-label="Search members"
          />
        </div>

        {membersLoading ? (
          <div className="text-center text-gray-400 dark:text-gray-500 py-8 text-sm">Loading members...</div>
        ) : members.length === 0 ? (
          <div className="text-center text-gray-400 dark:text-gray-500 py-8 text-sm">No members found.</div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
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
                    className="border-b border-gray-50 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                    onClick={() => onOpenDetail('user', m.id, m.displayName)}
                  >
                    <td className="py-1.5 text-blue-600 dark:text-blue-400 hover:underline">{m.displayName}</td>
                    <td className="py-1.5 text-gray-600 dark:text-gray-400">{m.email || '-'}</td>
                    <td className="py-1.5 text-gray-600 dark:text-gray-400">{m.jobTitle || '-'}</td>
                    <td className="py-1.5">
                      {m.principalType && (
                        <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded px-1.5 py-0.5">{m.principalType}</span>
                      )}
                    </td>
                    <td className="py-1.5">
                      {m.accountEnabled != null && (
                        <span className={`text-xs rounded px-1.5 py-0.5 ${m.accountEnabled
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                          : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'}`}>
                          {m.accountEnabled ? 'Active' : 'Disabled'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
                <button
                  onClick={() => setMemberPage(p => Math.max(0, p - 1))}
                  disabled={memberPage === 0}
                  className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-200 dark:border-gray-600 rounded px-2 py-1"
                >
                  Previous
                </button>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  Page {memberPage + 1} of {totalPages}
                </span>
                <button
                  onClick={() => setMemberPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={memberPage >= totalPages - 1}
                  className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-200 dark:border-gray-600 rounded px-2 py-1"
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
