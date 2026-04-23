import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection from './RiskScoreSection';
import ConfidenceBar from './ConfidenceBar';
import { TIER_STYLES } from '../utils/tierStyles';
import { formatDate } from '../utils/formatters';
import EntityGraph from './EntityGraph';
import EntityDetailLayout, { AttributesTable, buildAttributeEntries } from './EntityDetailLayout';

const SYSTEM_COLS = new Set([
  'SysStartTime', 'SysEndTime', 'ValidFrom', 'ValidTo',
  // Identity header already shows these; no point repeating in the table.
  'displayName', 'contextId', 'contextDisplayName',
]);

const TYPE_STYLES = {
  Regular:  { bg: 'bg-blue-100',   text: 'text-blue-800',   border: 'border-blue-200',   dot: 'bg-blue-500' },
  Admin:    { bg: 'bg-red-100',    text: 'text-red-800',    border: 'border-red-200',    dot: 'bg-red-500' },
  Test:     { bg: 'bg-amber-100',  text: 'text-amber-800',  border: 'border-amber-200',  dot: 'bg-amber-500' },
  Service:  { bg: 'bg-purple-100', text: 'text-purple-800', border: 'border-purple-200', dot: 'bg-purple-500' },
  Shared:   { bg: 'bg-teal-100',   text: 'text-teal-800',   border: 'border-teal-200',   dot: 'bg-teal-500' },
  External: { bg: 'bg-gray-100',   text: 'text-gray-600',   border: 'border-gray-200',   dot: 'bg-gray-400' },
};

function RiskTierBadge({ tier }) {
  if (!tier || tier === 'None') return null;
  const s = TIER_STYLES[tier] || TIER_STYLES.Minimal;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium ${s.bg} ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {tier}
    </span>
  );
}

function AccountTypeBadge({ type }) {
  const s = TYPE_STYLES[type] || TYPE_STYLES.Regular;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${s.bg} ${s.text} ${s.border} border`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {type}
    </span>
  );
}

export default function IdentityDetailPage({ identityId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [members, setMembers] = useState([]);
  const [aggregate, setAggregate] = useState({});
  const [riskData, setRiskData] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [overrideForm, setOverrideForm] = useState(null);

  // Graph state
  const [activeKey, setActiveKey] = useState('accounts'); // default to showing linked accounts
  const [listCache, setListCache] = useState({});
  const [listLoading, setListLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/risk-scores/identities/${identityId}`);
        if (res.ok) setRiskData(await res.json());
      } catch { /* risk data optional */ }
    })();
  }, [authFetch, identityId]);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/identities/${identityId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setIdentity(data.identity);
      setMembers(data.members || []);
      setAggregate(data.aggregateAssignments || {});
      if (onCacheData) onCacheData(identityId, 'identity', data);
    } catch (err) {
      console.error('Failed to load identity detail:', err);
      setError(err.message || 'Failed to load identity details');
    } finally {
      setLoading(false);
    }
  }, [authFetch, identityId, onCacheData]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  // ─── Node-click list fetch ──────────────────────────────────────────
  const fetchList = useCallback(async (key) => {
    if (listCache[key]) return;
    setListLoading(true);
    try {
      let items = [];
      if (key === 'accounts') {
        items = members;
      } else if (key === 'context') {
        if (identity?.contextId) {
          const r = await authFetch(`/api/contexts/${encodeURIComponent(identity.contextId)}`);
          const d = r.ok ? await r.json() : null;
          // /api/contexts/:id returns { attributes, members, subContexts }
          if (d?.attributes) items = [d.attributes];
        }
      } else if (['groups-direct', 'groups-governed', 'groups-owner', 'groups-eligible', 'oauth2-grants'].includes(key)) {
        const type = {
          'groups-direct': 'Direct',
          'groups-governed': 'Governed',
          'groups-owner': 'Owner',
          'groups-eligible': 'Eligible',
          'oauth2-grants': 'OAuth2Grant',
        }[key];
        const r = await authFetch(`/api/identities/${encodeURIComponent(identityId)}/assignments?type=${type}`);
        items = r.ok ? await r.json() : [];
      }
      setListCache(prev => ({ ...prev, [key]: items }));
    } finally {
      setListLoading(false);
    }
  }, [identityId, authFetch, listCache, members, identity]);

  const handleNodeClick = useCallback((key) => {
    setActiveKey(key);
    fetchList(key);
  }, [fetchList]);

  // Prime the accounts list cache whenever members change (default node).
  useEffect(() => {
    if (members.length > 0 && !listCache.accounts) {
      setListCache(prev => ({ ...prev, accounts: members }));
    }
  }, [members, listCache.accounts]);

  // Actions (verify, override) kept from the previous implementation.
  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await authFetch(`/api/identities/${identityId}/verify`, {
        method: identity.analystVerified ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: '' }),
      });
      if (res.ok) await fetchDetail();
    } catch (err) { console.error('Failed to update verification:', err); }
    finally { setVerifying(false); }
  };

  const handleMemberOverride = async (userId) => {
    if (!overrideForm || overrideForm.userId !== userId) return;
    if (!overrideForm.reason || overrideForm.reason.trim().length < 3) return;
    try {
      const res = await authFetch(`/api/identities/${identityId}/members/${userId}/override`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: overrideForm.action, reason: overrideForm.reason.trim() }),
      });
      if (res.ok) { setOverrideForm(null); await fetchDetail(); }
    } catch (err) { console.error('Failed to save member override:', err); }
  };

  const handleRemoveOverride = async (userId) => {
    try {
      const res = await authFetch(`/api/identities/${identityId}/members/${userId}/override`, { method: 'DELETE' });
      if (res.ok) await fetchDetail();
    } catch (err) { console.error('Failed to remove override:', err); }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading identity details...</div></div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md mx-auto mt-12">
        <h2 className="text-red-800 font-semibold text-lg">Failed to load identity</h2>
        <p className="text-red-600 mt-2 text-sm">{error}</p>
        <div className="flex gap-3 mt-3">
          <button onClick={fetchDetail} className="text-sm text-red-700 underline hover:text-red-900">Retry</button>
          <button onClick={onClose} className="text-sm text-gray-500 underline hover:text-gray-700">Close</button>
        </div>
      </div>
    );
  }
  if (!identity) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-400 text-sm">
        Identity not found.
        <button onClick={onClose} className="ml-2 text-blue-500 underline hover:text-blue-700">Close</button>
      </div>
    );
  }

  // Build a cleaned attribute view from the identity record.
  const cleaned = {};
  for (const [k, v] of Object.entries(identity)) {
    if (!SYSTEM_COLS.has(k) && v != null && v !== '') cleaned[k] = v;
  }
  const attributeEntries = buildAttributeEntries(cleaned, null, new Set());

  // ─── Graph nodes ──────────────────────────────────────────────────
  const hrAccount = members.find(m => m.isHrAuthoritative);
  const nodes = [
    { key: 'accounts', label: 'Linked Accounts', count: members.length, accent: 'blue' },
    { key: 'context', label: 'Context', count: identity.contextId ? 1 : 0, accent: 'purple' },
    { key: 'groups-direct', label: 'Groups (Direct)', count: aggregate.Direct || 0, accent: 'lime' },
    { key: 'groups-governed', label: 'Governed', count: aggregate.Governed || 0, accent: 'blue' },
    { key: 'groups-owner', label: 'Owned', count: aggregate.Owner || 0, accent: 'amber' },
    { key: 'groups-eligible', label: 'Eligible', count: aggregate.Eligible || 0, accent: 'purple' },
    { key: 'oauth2-grants', label: 'OAuth2 Grants', count: aggregate.OAuth2Grant || 0, accent: 'red' },
  ];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center text-sm font-bold">ID</div>
              <div>
                <h2 className="text-xl font-semibold text-gray-900">{identity.displayName || identityId}</h2>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-sm text-gray-500">{identity.accountCount} account{identity.accountCount !== 1 ? 's' : ''}</span>
                  {identity.contextDisplayName && (
                    <button onClick={() => onOpenDetail?.('context', identity.contextId, identity.contextDisplayName)}
                            className="text-sm text-blue-600 hover:text-blue-800 hover:underline">
                      {identity.contextDisplayName}
                    </button>
                  )}
                  {hrAccount?.jobTitle && <span className="text-sm text-gray-500">{hrAccount.jobTitle}</span>}
                  {identity.correlationConfidence != null && <ConfidenceBar confidence={identity.correlationConfidence} />}
                  {identity.analystVerified && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 border border-green-200">
                      Verified
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleVerify} disabled={verifying}
              className={`text-xs px-3 py-1.5 rounded border ${
                identity.analystVerified
                  ? 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                  : 'bg-green-50 border-green-300 text-green-700 hover:bg-green-100'
              }`}>
              {identity.analystVerified ? 'Remove Verification' : 'Verify Identity'}
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1" title="Close">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <EntityDetailLayout
        left={<AttributesTable entries={attributeEntries} />}
        right={
          <div className="space-y-4">
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
              <EntityGraph
                centerLabel="Identity"
                centerSubLabel={identity.displayName}
                nodes={nodes}
                activeKey={activeKey}
                onNodeClick={handleNodeClick}
              />
              {activeKey && (
                <div className="text-xs text-gray-400 dark:text-gray-500 text-center pb-2">
                  Showing <span className="font-medium text-gray-600">{nodes.find(n => n.key === activeKey)?.label}</span>
                  {' — '}
                  <button onClick={() => setActiveKey(null)} className="text-gray-500 hover:text-gray-700 underline">clear</button>
                </div>
              )}
            </div>

            {activeKey ? (
              <IdentityRelationshipList
                nodeKey={activeKey}
                items={listCache[activeKey]}
                loading={listLoading}
                onOpenDetail={onOpenDetail}
                overrideForm={overrideForm}
                setOverrideForm={setOverrideForm}
                onSaveOverride={handleMemberOverride}
                onRemoveOverride={handleRemoveOverride}
              />
            ) : (
              <div className="bg-white dark:bg-gray-800 border border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-6 text-center">
                <p className="text-sm text-gray-400">Click a node in the graph to see its details.</p>
              </div>
            )}
          </div>
        }
      >
        {riskData && <RiskScoreSection attributes={riskData} entityType="identities" entityId={identityId} authFetch={authFetch} />}

        {identity.correlationSignals && (
          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Correlation Signals</h3>
            <div className="flex flex-wrap gap-1.5">
              {identity.correlationSignals.split(',').map(s => (
                <span key={s} className="inline-block bg-indigo-50 text-indigo-700 px-2 py-1 rounded text-xs">{s.trim()}</span>
              ))}
            </div>
          </div>
        )}
      </EntityDetailLayout>
    </div>
  );
}

// ─── Relationship list dispatcher ──────────────────────────────────────

function IdentityRelationshipList({ nodeKey, items, loading, onOpenDetail,
                                    overrideForm, setOverrideForm, onSaveOverride, onRemoveOverride }) {
  if (loading && !items) {
    return <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-sm text-gray-500">Loading…</div>;
  }
  if (!items || items.length === 0) {
    return <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-sm text-gray-400 italic">Nothing to show for this relationship.</div>;
  }
  if (nodeKey === 'accounts') {
    return <LinkedAccountsTable items={items} onOpenDetail={onOpenDetail}
                                overrideForm={overrideForm} setOverrideForm={setOverrideForm}
                                onSaveOverride={onSaveOverride} onRemoveOverride={onRemoveOverride} />;
  }
  if (nodeKey === 'context') {
    return (
      <ListShell count={items.length}>
        <div className="divide-y divide-gray-50">
          {items.map(c => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/40">
              <div className="min-w-0 flex-1">
                <button onClick={() => onOpenDetail?.('context', c.id, c.displayName)}
                        className="text-sm font-medium text-blue-700 hover:text-blue-900 hover:underline text-left">
                  {c.displayName || c.id}
                </button>
                <div className="text-xs text-gray-400">
                  {[c.contextType, c.parentContextDisplayName].filter(Boolean).join(' • ') || '—'}
                </div>
              </div>
            </div>
          ))}
        </div>
      </ListShell>
    );
  }
  // Groups + OAuth2 grants — all returned by /assignments with resource + principal columns
  return <AggregateAssignmentTable items={items} onOpenDetail={onOpenDetail} />;
}

function ListShell({ count, children }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Selected</h3>
        <span className="text-xs text-gray-500">{count}</span>
      </div>
      <div className="max-h-[460px] overflow-y-auto">{children}</div>
    </div>
  );
}

function AggregateAssignmentTable({ items, onOpenDetail }) {
  return (
    <ListShell count={items.length}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700 sticky top-0">
            <th className="px-4 py-2 font-medium">Resource</th>
            <th className="px-4 py-2 font-medium">Via Account</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a, i) => (
            <tr key={(a.resourceId || '') + ':' + (a.principalId || '') + ':' + i} className="border-b border-gray-50 hover:bg-gray-50 dark:hover:bg-gray-700/40">
              <td className="px-4 py-2">
                {a.resourceId ? (
                  <button onClick={() => onOpenDetail?.('resource', a.resourceId, a.resourceDisplayName)}
                          className="text-blue-700 hover:text-blue-900 hover:underline font-medium">
                    {a.resourceDisplayName || a.resourceId}
                  </button>
                ) : <span className="text-gray-400 italic">—</span>}
                <div className="text-xs text-gray-400">{a.resourceType}</div>
              </td>
              <td className="px-4 py-2">
                <button onClick={() => onOpenDetail?.('user', a.principalId, a.principalDisplayName)}
                        className="text-blue-700 hover:text-blue-900 hover:underline text-sm">
                  {a.principalDisplayName || a.userPrincipalName || a.principalId}
                </button>
                {a.isPrimary && <span className="ml-1 text-[10px] text-blue-600">Primary</span>}
              </td>
              <td className="px-4 py-2 text-xs text-gray-500">{a.accountType || '—'}</td>
              <td className="px-4 py-2 text-xs text-gray-500">
                {a.assignmentStatus || a.state || '—'}
                {a.expirationDateTime && <span className="text-gray-400 ml-1">· exp {formatDate(a.expirationDateTime)}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListShell>
  );
}

function LinkedAccountsTable({ items, onOpenDetail, overrideForm, setOverrideForm, onSaveOverride, onRemoveOverride }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Linked Accounts</h3>
        <span className="text-xs text-gray-500">{items.length}</span>
      </div>
      <div className="max-h-[460px] overflow-x-auto overflow-y-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase bg-gray-50 sticky top-0">
              <th className="px-3 py-2">Account</th>
              <th className="px-3 py-2">UPN</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Risk</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Groups</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(m => (
              <tr key={m.principalId} className={`border-b border-gray-50 hover:bg-gray-50 ${m.analystOverride === 'rejected' ? 'opacity-50' : ''}`}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button onClick={() => onOpenDetail?.('user', m.principalId, m.displayName)}
                            className="text-blue-600 hover:text-blue-800 hover:underline font-medium">
                      {m.displayName}
                    </button>
                    {m.isPrimary && <span className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded border border-blue-200">Primary</span>}
                  </div>
                </td>
                <td className="px-3 py-2 text-gray-600 font-mono text-xs">{m.userPrincipalName}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <AccountTypeBadge type={m.accountType} />
                    {m.isHrAuthoritative && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 border border-emerald-200" title={`HR Score: ${m.hrScore}`}>HR</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2"><RiskTierBadge tier={m.riskTier} /></td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center gap-1 text-xs ${
                    m.accountEnabled === 'True' || m.userAccountEnabled === true ? 'text-green-600' : 'text-gray-400'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      m.accountEnabled === 'True' || m.userAccountEnabled === true ? 'bg-green-500' : 'bg-gray-300'
                    }`} />
                    {m.accountEnabled === 'True' || m.userAccountEnabled === true ? 'Enabled' : 'Disabled'}
                  </span>
                </td>
                <td className="px-3 py-2 text-gray-600">{m.groupCount ?? '-'}</td>
                <td className="px-3 py-2">
                  {m.analystOverride ? (
                    <div className="flex items-center gap-1">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        m.analystOverride === 'confirmed' ? 'bg-green-50 text-green-700' :
                        m.analystOverride === 'rejected' ? 'bg-red-50 text-red-700' : 'bg-yellow-50 text-yellow-700'
                      }`}>{m.analystOverride}</span>
                      <button onClick={() => onRemoveOverride(m.principalId)} className="text-xs text-gray-400 hover:text-red-600" title="Remove override">x</button>
                    </div>
                  ) : !m.isPrimary ? (
                    <div className="flex gap-1">
                      <button onClick={() => setOverrideForm({ userId: m.principalId, action: 'confirmed', reason: '' })}
                              className="text-xs text-green-600 hover:text-green-800 border border-green-200 rounded px-1.5 py-0.5">Confirm</button>
                      <button onClick={() => setOverrideForm({ userId: m.principalId, action: 'rejected', reason: '' })}
                              className="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-1.5 py-0.5">Reject</button>
                    </div>
                  ) : null}
                  {overrideForm && overrideForm.userId === m.principalId && (
                    <div className="mt-2 p-2 bg-gray-50 rounded border border-gray-200">
                      <div className="text-xs text-gray-500 mb-1">{overrideForm.action === 'confirmed' ? 'Confirm' : 'Reject'} this link:</div>
                      <input type="text" value={overrideForm.reason}
                             onChange={(e) => setOverrideForm({ ...overrideForm, reason: e.target.value })}
                             placeholder="Reason (min 3 chars)..."
                             className="w-full text-xs border border-gray-300 rounded px-2 py-1 mb-1" />
                      <div className="flex gap-1">
                        <button onClick={() => onSaveOverride(m.principalId)}
                                disabled={!overrideForm.reason || overrideForm.reason.trim().length < 3}
                                className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded disabled:opacity-50">Save</button>
                        <button onClick={() => setOverrideForm(null)} className="text-xs text-gray-500 px-2 py-0.5">Cancel</button>
                      </div>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
