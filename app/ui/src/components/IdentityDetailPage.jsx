import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection from './RiskScoreSection';
import ConfidenceBar from './ConfidenceBar';
import { TIER_STYLES } from '../utils/tierStyles';

// ─── Identity Detail Page ─────────────────────────────────────────────────────
// Shows details for a single identity: properties, linked accounts, overrides.
// Loaded via /api/identities/:id — follows the same tab pattern as OrgUnitDetailPage.

const SYSTEM_COLS = new Set(['SysStartTime', 'SysEndTime', 'ValidFrom', 'ValidTo']);

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


function cleanAttributes(raw) {
  if (!raw) return {};
  const clean = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!SYSTEM_COLS.has(key) && value != null && value !== '') {
      clean[key] = value;
    }
  }
  return clean;
}

export default function IdentityDetailPage({ identityId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [members, setMembers] = useState([]);
  const [riskData, setRiskData] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [overrideForm, setOverrideForm] = useState(null);

  // ─── Fetch risk score data ──────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/risk-scores/identities/${identityId}`);
        if (res.ok) setRiskData(await res.json());
      } catch { /* risk data optional */ }
    })();
  }, [authFetch, identityId]);

  // ─── Fetch identity detail ──────────────────────────────────────────
  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/identities/${identityId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setIdentity(data.identity);
      setMembers(data.members || []);
      if (onCacheData) onCacheData(identityId, 'identity', data);
    } catch (err) {
      console.error('Failed to load identity detail:', err);
      setError(err.message || 'Failed to load identity details');
    } finally {
      setLoading(false);
    }
  }, [authFetch, identityId, onCacheData]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  // ─── Actions ────────────────────────────────────────────────────────
  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await authFetch(`/api/identities/${identityId}/verify`, {
        method: identity.analystVerified ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: '' }),
      });
      if (res.ok) await fetchDetail();
    } catch (err) {
      console.error('Failed to update verification:', err);
    } finally {
      setVerifying(false);
    }
  };

  const handleMemberOverride = async (userId) => {
    if (!overrideForm || overrideForm.principalId !== userId) return;
    if (!overrideForm.reason || overrideForm.reason.trim().length < 3) return;
    try {
      const res = await authFetch(`/api/identities/${identityId}/members/${userId}/override`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: overrideForm.action, reason: overrideForm.reason.trim() }),
      });
      if (res.ok) {
        setOverrideForm(null);
        await fetchDetail();
      }
    } catch (err) {
      console.error('Failed to save member override:', err);
    }
  };

  const handleRemoveOverride = async (userId) => {
    try {
      const res = await authFetch(`/api/identities/${identityId}/members/${userId}/override`, { method: 'DELETE' });
      if (res.ok) await fetchDetail();
    } catch (err) {
      console.error('Failed to remove override:', err);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading identity details...</div>
      </div>
    );
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

  const attrs = cleanAttributes(identity);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center text-sm font-bold">
                ID
              </div>
              <div>
                <h2 className="text-xl font-semibold text-gray-900">{identity.displayName || identityId}</h2>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-sm text-gray-500">
                    {identity.accountCount} account{identity.accountCount !== 1 ? 's' : ''}
                  </span>
                  {identity.contextDisplayName && (
                    <button
                      onClick={() => onOpenDetail?.('context', identity.contextId, identity.contextDisplayName)}
                      className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
                    >{identity.contextDisplayName}</button>
                  )}
                  {!identity.contextDisplayName && identity.department && (
                    <span className="text-sm text-gray-500">{identity.department}</span>
                  )}
                  {identity.jobTitle && (
                    <span className="text-sm text-gray-500">{identity.jobTitle}</span>
                  )}
                  {identity.correlationConfidence != null && (
                    <ConfidenceBar confidence={identity.correlationConfidence} />
                  )}
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
            <button
              onClick={handleVerify}
              disabled={verifying}
              className={`text-xs px-3 py-1.5 rounded border ${
                identity.analystVerified
                  ? 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                  : 'bg-green-50 border-green-300 text-green-700 hover:bg-green-100'
              }`}
            >
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

      {/* Risk Score */}
      {riskData && <RiskScoreSection attributes={riskData} entityType="identities" entityId={identityId} authFetch={authFetch} />}

      {/* Attributes */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Attributes</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
          {Object.entries(attrs).map(([key, value]) => (
            <div key={key} className="flex items-baseline gap-2 py-1">
              <span className="text-xs text-gray-500 font-medium min-w-[140px]">{key}</span>
              <span className="text-sm text-gray-900 break-all">{String(value)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Correlation Signals */}
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

      {/* Linked Accounts */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">
          Linked Accounts ({members.length})
        </h3>

        {members.length === 0 ? (
          <div className="text-center text-gray-400 py-8 text-sm">No linked accounts found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                <th className="pb-2 pr-3">Account</th>
                <th className="pb-2 pr-3">UPN</th>
                <th className="pb-2 pr-3">Type</th>
                <th className="pb-2 pr-3">Risk</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3">Confidence</th>
                <th className="pb-2 pr-3">Groups</th>
                <th className="pb-2 pr-3">Last Sign-In</th>
                <th className="pb-2 pr-3">Signals</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map(m => (
                <tr key={m.principalId} className={`border-b border-gray-50 hover:bg-gray-50 ${m.analystOverride === 'rejected' ? 'opacity-50' : ''}`}>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => onOpenDetail?.('user', m.principalId, m.displayName)}
                        className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                      >
                        {m.displayName}
                      </button>
                      {m.isPrimary && (
                        <span className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded border border-blue-200">Primary</span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-gray-600 font-mono text-xs">{m.userPrincipalName}</td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-1">
                      <AccountTypeBadge type={m.accountType} />
                      {m.isHrAuthoritative && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 border border-emerald-200" title={`HR Score: ${m.hrScore}`}>
                          HR
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3"><RiskTierBadge tier={m.riskTier} /></td>
                  <td className="py-2 pr-3">
                    <span className={`inline-flex items-center gap-1 text-xs ${
                      m.accountEnabled === 'True' || m.userAccountEnabled === true ? 'text-green-600' : 'text-gray-400'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        m.accountEnabled === 'True' || m.userAccountEnabled === true ? 'bg-green-500' : 'bg-gray-300'
                      }`} />
                      {m.accountEnabled === 'True' || m.userAccountEnabled === true ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td className="py-2 pr-3"><ConfidenceBar confidence={m.signalConfidence} /></td>
                  <td className="py-2 pr-3 text-gray-600">{m.groupCount ?? '-'}</td>
                  <td className="py-2 pr-3 text-xs text-gray-500">
                    {m.lastSignInDateTime ? new Date(m.lastSignInDateTime).toLocaleDateString() : '-'}
                  </td>
                  <td className="py-2 pr-3 text-xs text-gray-400 max-w-48 truncate" title={m.correlationSignals}>
                    {m.correlationSignals || (m.isPrimary ? 'Primary account' : '-')}
                  </td>
                  <td className="py-2">
                    {m.analystOverride ? (
                      <div className="flex items-center gap-1">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          m.analystOverride === 'confirmed' ? 'bg-green-50 text-green-700' :
                          m.analystOverride === 'rejected' ? 'bg-red-50 text-red-700' :
                          'bg-yellow-50 text-yellow-700'
                        }`}>{m.analystOverride}</span>
                        <button
                          onClick={() => handleRemoveOverride(m.principalId)}
                          className="text-xs text-gray-400 hover:text-red-600"
                          title="Remove override"
                        >x</button>
                      </div>
                    ) : !m.isPrimary ? (
                      <div className="flex gap-1">
                        <button
                          onClick={() => setOverrideForm({ userId: m.principalId, action: 'confirmed', reason: '' })}
                          className="text-xs text-green-600 hover:text-green-800 border border-green-200 rounded px-1.5 py-0.5"
                        >Confirm</button>
                        <button
                          onClick={() => setOverrideForm({ userId: m.principalId, action: 'rejected', reason: '' })}
                          className="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-1.5 py-0.5"
                        >Reject</button>
                      </div>
                    ) : null}
                    {overrideForm && overrideForm.principalId === m.principalId && (
                      <div className="mt-2 p-2 bg-gray-50 rounded border border-gray-200">
                        <div className="text-xs text-gray-500 mb-1">
                          {overrideForm.action === 'confirmed' ? 'Confirm' : 'Reject'} this link:
                        </div>
                        <input
                          type="text"
                          value={overrideForm.reason}
                          onChange={(e) => setOverrideForm({ ...overrideForm, reason: e.target.value })}
                          placeholder="Reason (min 3 chars)..."
                          className="w-full text-xs border border-gray-300 rounded px-2 py-1 mb-1"
                        />
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleMemberOverride(m.principalId)}
                            disabled={!overrideForm.reason || overrideForm.reason.trim().length < 3}
                            className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded disabled:opacity-50"
                          >Save</button>
                          <button
                            onClick={() => setOverrideForm(null)}
                            className="text-xs text-gray-500 px-2 py-0.5"
                          >Cancel</button>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
