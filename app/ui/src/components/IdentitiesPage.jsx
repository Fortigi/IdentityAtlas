import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import ConfidenceBar from './ConfidenceBar';

// ─── Account type badge styles ──────────────────────────────────────────
const RISK_TIER_STYLES = {
  Critical: { bg: 'bg-red-100',    text: 'text-red-800',    dot: 'bg-red-500' },
  High:     { bg: 'bg-orange-100', text: 'text-orange-800', dot: 'bg-orange-500' },
  Medium:   { bg: 'bg-yellow-100', text: 'text-yellow-800', dot: 'bg-yellow-500' },
  Low:      { bg: 'bg-blue-100',   text: 'text-blue-800',   dot: 'bg-blue-500' },
  Minimal:  { bg: 'bg-gray-100',   text: 'text-gray-600',   dot: 'bg-gray-400' },
};

function RiskTierBadge({ tier }) {
  if (!tier || tier === 'None') return null;
  const s = RISK_TIER_STYLES[tier] || RISK_TIER_STYLES.Minimal;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium ${s.bg} ${s.text}`} title={`Risk: ${tier}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {tier}
    </span>
  );
}

const TYPE_STYLES = {
  Regular:  { bg: 'bg-blue-100',   text: 'text-blue-800',   border: 'border-blue-200',   dot: 'bg-blue-500' },
  Admin:    { bg: 'bg-red-100',    text: 'text-red-800',    border: 'border-red-200',    dot: 'bg-red-500' },
  Test:     { bg: 'bg-amber-100',  text: 'text-amber-800',  border: 'border-amber-200',  dot: 'bg-amber-500' },
  Service:  { bg: 'bg-purple-100', text: 'text-purple-800', border: 'border-purple-200', dot: 'bg-purple-500' },
  Shared:   { bg: 'bg-teal-100',   text: 'text-teal-800',   border: 'border-teal-200',   dot: 'bg-teal-500' },
  External: { bg: 'bg-gray-100',   text: 'text-gray-600',   border: 'border-gray-200',   dot: 'bg-gray-400' },
};

function AccountTypeBadge({ type }) {
  const s = TYPE_STYLES[type] || TYPE_STYLES.Regular;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${s.bg} ${s.text} ${s.border} border`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {type}
    </span>
  );
}


function VerifiedBadge({ verified }) {
  if (!verified) return null;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200">
      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
      Verified
    </span>
  );
}

// ─── Orphaned Accounts Notice ────────────────────────────────────────────

function OrphanedAccountsNotice({ orphanCount, onShowOrphans, allVisible }) {
  if (!Number(orphanCount)) return null;
  return (
    <div className="bg-orange-50 border border-orange-200 rounded-lg px-4 py-3 mb-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <svg className="w-5 h-5 text-orange-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
        <div>
          {allVisible
            ? <><span className="text-sm font-medium text-orange-800">{orphanCount} identit{orphanCount !== 1 ? 'ies' : 'y'} have no HR anchor</span>
                <span className="text-xs text-orange-600 ml-2">— no HR-authoritative account found. Re-run correlation with HR indicators to resolve.</span></>
            : <><span className="text-sm font-medium text-orange-800">{orphanCount} orphaned account group{orphanCount !== 1 ? 's' : ''} not shown</span>
                <span className="text-xs text-orange-600 ml-2">— correlated accounts with no HR-authoritative anchor</span></>
          }
        </div>
      </div>
      {!allVisible && (
        <button
          onClick={onShowOrphans}
          className="text-xs text-orange-700 border border-orange-300 bg-white hover:bg-orange-50 px-3 py-1 rounded whitespace-nowrap"
        >
          Show orphaned accounts
        </button>
      )}
    </div>
  );
}

// ─── Summary Cards ──────────────────────────────────────────────────────

function OrphanBadge({ status }) {
  if (!status) return null;
  const labels = {
    'no-hr-anchor': 'No HR Anchor',
    'disabled-no-anchor': 'Disabled',
    'no-regular-account': 'No Regular Account',
  };
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800 border border-orange-200">
      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
      {labels[status] || status}
    </span>
  );
}

function HrBadge({ isHrAnchored }) {
  if (!isHrAnchored) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-200">
      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" /></svg>
      HR Source
    </span>
  );
}

function SummaryCards({ summary, hasHrColumns }) {
  if (!summary) return null;

  // Lead with total identities; when HR columns exist, add HR-anchored + orphaned as supporting stats
  const cards = hasHrColumns && summary.hrAnchoredCount != null ? [
    { label: 'Identities', value: summary.totalIdentities, color: 'text-emerald-700', primary: true },
    { label: 'Multi-Account', value: summary.multiAccountIdentities, color: 'text-blue-600' },
    { label: 'Single Account', value: summary.singleAccountIdentities, color: 'text-gray-500' },
    { label: 'Verified', value: summary.verifiedCount, color: 'text-green-600' },
    { label: 'Avg Confidence', value: summary.avgConfidence ? `${Math.round(summary.avgConfidence)}%` : '—', color: 'text-indigo-600' },
    { label: 'HR-Anchored', value: summary.hrAnchoredCount || 0, color: summary.hrAnchoredCount > 0 ? 'text-teal-600' : 'text-gray-400', title: 'Identities with a confirmed HR-authoritative account' },
    { label: 'Orphaned', value: summary.orphanCount || 0, color: summary.orphanCount > 0 ? 'text-orange-600' : 'text-gray-400' },
  ] : [
    { label: 'Total Identities', value: summary.totalIdentities, color: 'text-gray-900' },
    { label: 'Multi-Account', value: summary.multiAccountIdentities, color: 'text-blue-600' },
    { label: 'Single Account', value: summary.singleAccountIdentities, color: 'text-gray-500' },
    { label: 'Verified', value: summary.verifiedCount, color: 'text-green-600' },
    { label: 'Avg Confidence', value: summary.avgConfidence ? `${Math.round(summary.avgConfidence)}%` : '—', color: 'text-indigo-600' },
  ];

  return (
    <div className={`grid gap-3 mb-4`} style={{ gridTemplateColumns: `repeat(${cards.length}, minmax(0, 1fr))` }}>
      {cards.map(c => (
        <div key={c.label} title={c.title} className={`rounded-lg border px-4 py-3 ${c.primary ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-gray-200'}`}>
          <div className="text-xs text-gray-500 mb-1">{c.label}</div>
          <div className={`text-xl font-semibold ${c.color}`}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Account Type Distribution ──────────────────────────────────────────

function TypeDistribution({ distribution }) {
  if (!distribution || distribution.length === 0) return null;
  const total = distribution.reduce((sum, d) => sum + d.cnt, 0);

  return (
    <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 mb-4">
      <div className="text-xs text-gray-500 mb-2">Account Type Distribution</div>
      <div className="flex gap-4">
        {distribution.map(d => (
          <div key={d.accountType} className="flex items-center gap-2">
            <AccountTypeBadge type={d.accountType} />
            <span className="text-sm text-gray-600">{d.cnt}</span>
            <span className="text-xs text-gray-400">({Math.round(d.cnt / total * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Identity Detail Panel ──────────────────────────────────────────────

function IdentityDetail({ identityId, authFetch, onClose, onOpenDetail, onRefresh }) {
  const [identity, setIdentity] = useState(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [overrideForm, setOverrideForm] = useState(null); // { userId, action, reason }

  const fetchDetail = useCallback(async () => {
    try {
      const res = await authFetch(`/api/identities/${identityId}`);
      if (res.ok) {
        const data = await res.json();
        setIdentity(data.identity);
        setMembers(data.members);
      }
    } catch (err) {
      console.error('Failed to load identity detail:', err);
    } finally {
      setLoading(false);
    }
  }, [identityId, authFetch]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await authFetch(`/api/identities/${identityId}/verify`, {
        method: identity.analystVerified ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: '' }),
      });
      if (res.ok) {
        await fetchDetail();
        onRefresh?.();
      }
    } catch (err) {
      console.error('Failed to update verification:', err);
    } finally {
      setVerifying(false);
    }
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
      if (res.ok) {
        setOverrideForm(null);
        await fetchDetail();
        onRefresh?.();
      }
    } catch (err) {
      console.error('Failed to save member override:', err);
    }
  };

  const handleRemoveOverride = async (userId) => {
    try {
      const res = await authFetch(`/api/identities/${identityId}/members/${userId}/override`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await fetchDetail();
        onRefresh?.();
      }
    } catch (err) {
      console.error('Failed to remove override:', err);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="text-gray-400">Loading identity detail...</div>
      </div>
    );
  }

  if (!identity) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">{identity.displayName}</h3>
          <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
            <span>{identity.accountCount} account{identity.accountCount !== 1 ? 's' : ''}</span>
            <span>{identity.department || '—'}</span>
            <span>{identity.jobTitle || '—'}</span>
            <ConfidenceBar confidence={identity.correlationConfidence} />
            <VerifiedBadge verified={identity.analystVerified} />
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
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      {/* Identity attributes */}
      <div className="px-6 py-3 border-b border-gray-100 grid grid-cols-4 gap-4 text-sm">
        <div><span className="text-gray-500">Email:</span> <span className="text-gray-900">{identity.mail || '—'}</span></div>
        <div><span className="text-gray-500">Employee ID:</span> <span className="text-gray-900">{identity.employeeId || '—'}</span></div>
        <div><span className="text-gray-500">Company:</span> <span className="text-gray-900">{identity.companyName || '—'}</span></div>
        <div><span className="text-gray-500">Location:</span> <span className="text-gray-900">{[identity.city, identity.country].filter(Boolean).join(', ') || '—'}</span></div>
      </div>

      {/* Correlation signals */}
      {identity.correlationSignals && (
        <div className="px-6 py-2 border-b border-gray-100 text-xs text-gray-500">
          Signals: {identity.correlationSignals.split(',').map(s => (
            <span key={s} className="inline-block bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded mr-1">{s.trim()}</span>
          ))}
        </div>
      )}

      {/* Members table */}
      <div className="px-6 py-4">
        <h4 className="text-sm font-medium text-gray-700 mb-3">Linked Accounts</h4>
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
              <tr key={m.userId} className={`border-b border-gray-50 hover:bg-gray-50 ${m.analystOverride === 'rejected' ? 'opacity-50' : ''}`}>
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onOpenDetail?.('user', m.userId, m.displayName)}
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
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 border border-emerald-200" title={`HR Score: ${m.hrScore}, Indicators: ${m.hrIndicators || 'none'}`}>
                        HR
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-2 pr-3"><RiskTierBadge tier={m.riskTier} /></td>
                <td className="py-2 pr-3">
                  <span className={`inline-flex items-center gap-1 text-xs ${
                    m.accountEnabled === 'True' || m.userAccountEnabled === true
                      ? 'text-green-600' : 'text-gray-400'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      m.accountEnabled === 'True' || m.userAccountEnabled === true
                        ? 'bg-green-500' : 'bg-gray-300'
                    }`} />
                    {m.accountEnabled === 'True' || m.userAccountEnabled === true ? 'Enabled' : 'Disabled'}
                  </span>
                </td>
                <td className="py-2 pr-3"><ConfidenceBar confidence={m.signalConfidence} /></td>
                <td className="py-2 pr-3 text-gray-600">{m.groupCount ?? '—'}</td>
                <td className="py-2 pr-3 text-xs text-gray-500">
                  {m.lastSignInDateTime ? new Date(m.lastSignInDateTime).toLocaleDateString() : '—'}
                </td>
                <td className="py-2 pr-3 text-xs text-gray-400 max-w-48 truncate" title={m.correlationSignals}>
                  {m.correlationSignals || (m.isPrimary ? 'Primary account' : '—')}
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
                        onClick={() => handleRemoveOverride(m.userId)}
                        className="text-xs text-gray-400 hover:text-red-600"
                        title="Remove override"
                      >x</button>
                    </div>
                  ) : !m.isPrimary ? (
                    <div className="flex gap-1">
                      <button
                        onClick={() => setOverrideForm({ userId: m.userId, action: 'confirmed', reason: '' })}
                        className="text-xs text-green-600 hover:text-green-800 border border-green-200 rounded px-1.5 py-0.5"
                        title="Confirm this correlation"
                      >Confirm</button>
                      <button
                        onClick={() => setOverrideForm({ userId: m.userId, action: 'rejected', reason: '' })}
                        className="text-xs text-red-600 hover:text-red-800 border border-red-200 rounded px-1.5 py-0.5"
                        title="Reject this correlation"
                      >Reject</button>
                    </div>
                  ) : null}
                  {overrideForm && overrideForm.userId === m.userId && (
                    <div className="mt-2 p-2 bg-gray-50 rounded border border-gray-200">
                      <div className="text-xs text-gray-500 mb-1">
                        {overrideForm.action === 'confirmed' ? 'Confirm' : 'Reject'} this link — reason:
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
                          onClick={() => handleMemberOverride(m.userId)}
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
      </div>
    </div>
  );
}

// ─── Main Page Component ────────────────────────────────────────────────

export default function IdentitiesPage({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const [data, setData] = useState([]);
  const [summary, setSummary] = useState(null);
  const [total, setTotal] = useState(0);
  const [available, setAvailable] = useState(true);
  const [hasHrColumns, setHasHrColumns] = useState(false);
  const [loading, setLoading] = useState(true);
  // expandedId removed — identities now open as detail tabs

  // Filters
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [minAccounts, setMinAccounts] = useState(1); // Default: show all identities
  const [accountTypeFilter, setAccountTypeFilter] = useState('');
  const [verifiedFilter, setVerifiedFilter] = useState('');
  const [hrAnchoredFilter, setHrAnchoredFilter] = useState(''); // default: all identities
  const [orphanFilter, setOrphanFilter] = useState('');
  const [sortBy, setSortBy] = useState('accountCount');
  const [offset, setOffset] = useState(0);
  const [pageSize] = useState(50);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (minAccounts > 1) params.set('minAccounts', minAccounts);
      if (accountTypeFilter) params.set('accountType', accountTypeFilter);
      if (verifiedFilter) params.set('verified', verifiedFilter);
      if (hrAnchoredFilter) params.set('hrAnchored', hrAnchoredFilter);
      if (orphanFilter) params.set('orphanStatus', orphanFilter);
      if (sortBy) params.set('sort', sortBy);
      params.set('limit', pageSize);
      params.set('offset', offset);

      const res = await authFetch(`/api/identities?${params}`);
      if (res.ok) {
        const result = await res.json();
        setAvailable(result.available);
        setSummary(result.summary);
        setData(result.data || []);
        setTotal(result.total || 0);
        setHasHrColumns(result.hasHrColumns || false);
      }
    } catch (err) {
      console.error('Failed to load identities:', err);
    } finally {
      setLoading(false);
    }
  }, [authFetch, debouncedSearch, minAccounts, accountTypeFilter, verifiedFilter, hrAnchoredFilter, orphanFilter, sortBy, offset, pageSize]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Reset offset on filter change
  useEffect(() => { setOffset(0); }, [debouncedSearch, minAccounts, accountTypeFilter, verifiedFilter, hrAnchoredFilter, orphanFilter]);

  if (!available) {
    return (
      <div className="p-6">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
          <h3 className="text-lg font-medium text-yellow-800 mb-2">Account Correlation Not Available</h3>
          <p className="text-sm text-yellow-700">
            Run <code className="bg-yellow-100 px-1.5 py-0.5 rounded font-mono text-xs">Invoke-FGAccountCorrelation</code> in PowerShell to generate identity correlations.
          </p>
          <p className="text-xs text-yellow-600 mt-2">
            First create a ruleset with <code className="bg-yellow-100 px-1 rounded font-mono">New-FGCorrelationRuleset | Save-FGCorrelationRuleset</code>
          </p>
        </div>
      </div>
    );
  }

  const totalPages = Math.ceil(total / pageSize);
  const currentPage = Math.floor(offset / pageSize) + 1;

  return (
    <div className="p-4">
      {/* Summary */}
      <SummaryCards summary={summary} hasHrColumns={hasHrColumns} />
      <TypeDistribution distribution={summary?.accountTypeDistribution} />

      {/* Orphaned accounts notice — when not already viewing orphans */}
      {hasHrColumns && hrAnchoredFilter !== 'false' && (
        <OrphanedAccountsNotice
          orphanCount={summary?.orphanCount}
          allVisible={hrAnchoredFilter === ''}
          onShowOrphans={() => { setHrAnchoredFilter('false'); setOrphanFilter('any'); setMinAccounts(1); }}
        />
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, UPN, mail, department..."
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-72 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />

        <label className="flex items-center gap-2 text-sm text-gray-600">
          <span>Min accounts:</span>
          <select
            value={minAccounts}
            onChange={(e) => setMinAccounts(parseInt(e.target.value))}
            className="border border-gray-300 rounded px-2 py-1 text-sm"
          >
            <option value="1">All (1+)</option>
            <option value="2">Multi-account (2+)</option>
            <option value="3">3+</option>
            <option value="4">4+</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm text-gray-600">
          <span>Type:</span>
          <select
            value={accountTypeFilter}
            onChange={(e) => setAccountTypeFilter(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm"
          >
            <option value="">All types</option>
            <option value="Admin">Has Admin</option>
            <option value="Test">Has Test</option>
            <option value="Service">Has Service</option>
            <option value="Shared">Has Shared</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm text-gray-600">
          <span>Verified:</span>
          <select
            value={verifiedFilter}
            onChange={(e) => setVerifiedFilter(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm"
          >
            <option value="">All</option>
            <option value="true">Verified only</option>
            <option value="false">Unverified only</option>
          </select>
        </label>

        {hasHrColumns && (
          <>
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <span>View:</span>
              <select
                value={hrAnchoredFilter}
                onChange={(e) => { setHrAnchoredFilter(e.target.value); if (e.target.value !== 'false') setOrphanFilter(''); }}
                className={`border rounded px-2 py-1 text-sm ${hrAnchoredFilter === 'true' ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : hrAnchoredFilter === 'false' ? 'border-orange-300 bg-orange-50 text-orange-800' : 'border-gray-300'}`}
              >
                <option value="true">Identities (HR-anchored)</option>
                <option value="false">Orphaned accounts</option>
                <option value="">All correlated groups</option>
              </select>
            </label>

            {hrAnchoredFilter === 'false' && (
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <span>Orphan type:</span>
                <select
                  value={orphanFilter}
                  onChange={(e) => setOrphanFilter(e.target.value)}
                  className="border border-gray-300 rounded px-2 py-1 text-sm"
                >
                  <option value="">All orphans</option>
                  <option value="any">Has orphan status</option>
                  <option value="no-hr-anchor">No HR Anchor</option>
                  <option value="disabled-no-anchor">Disabled</option>
                  <option value="no-regular-account">No Regular Account</option>
                </select>
              </label>
            )}
          </>
        )}

        <label className="flex items-center gap-2 text-sm text-gray-600">
          <span>Sort:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm"
          >
            <option value="accountCount">Account Count</option>
            <option value="confidence">Confidence</option>
            <option value="displayName">Name</option>
            <option value="department">Department</option>
          </select>
        </label>

        <span className="text-xs text-gray-400 ml-auto">
          {total} {hasHrColumns && hrAnchoredFilter === 'true' ? `real identit${total === 1 ? 'y' : 'ies'}` : hrAnchoredFilter === 'false' ? `orphaned group${total === 1 ? '' : 's'}` : `identit${total === 1 ? 'y' : 'ies'}`}
          {hasHrColumns && summary && hrAnchoredFilter !== 'true' && (summary.hrAnchoredCount ?? 0) > 0 && ` · ${summary.hrAnchoredCount} HR-anchored`}
        </span>
      </div>

      {/* Identity List */}
      {loading && data.length === 0 ? (
        <div className="text-center py-12 text-gray-400">Loading identities...</div>
      ) : data.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          {'No accounts match your filters'}
        </div>
      ) : (
        <div className="space-y-2">
          {data.map(identity => (
            <div
              key={identity.id}
              className="bg-white rounded-lg border border-gray-200 px-4 py-3 hover:border-blue-300 transition-colors"
            >
              <div className="flex items-center gap-4">
                {/* Name + account count — clickable to open detail tab */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onOpenDetail('identity', identity.id, identity.displayName)}
                      className="font-medium text-blue-600 hover:text-blue-800 hover:underline text-left"
                    >
                      {identity.displayName}
                    </button>
                    <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                      {identity.accountCount} account{identity.accountCount !== 1 ? 's' : ''}
                    </span>
                    <VerifiedBadge verified={identity.analystVerified} />
                    <HrBadge isHrAnchored={identity.isHrAnchored} />
                    <OrphanBadge status={identity.orphanStatus} />
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {identity.primaryAccountUpn}
                    {identity.department && ` · ${identity.department}`}
                    {identity.jobTitle && ` · ${identity.jobTitle}`}
                  </div>
                </div>

                {/* Account type badges */}
                <div className="flex gap-1">
                  {identity.accountTypes?.split(',').map(t => (
                    <AccountTypeBadge key={t} type={t.trim()} />
                  ))}
                </div>

                {/* Confidence */}
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-xs text-gray-400 uppercase tracking-wide leading-none">Confidence</span>
                  <ConfidenceBar confidence={identity.correlationConfidence} />
                </div>

                {/* Signals */}
                <div className="text-xs text-gray-400 w-32 truncate" title={identity.correlationSignals}>
                  {identity.correlationSignals || '-'}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm text-gray-600">
          <button
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
            disabled={offset === 0}
            className="px-3 py-1 border border-gray-300 rounded disabled:opacity-50 hover:bg-gray-50"
          >Previous</button>
          <span>Page {currentPage} of {totalPages}</span>
          <button
            onClick={() => setOffset(offset + pageSize)}
            disabled={currentPage >= totalPages}
            className="px-3 py-1 border border-gray-300 rounded disabled:opacity-50 hover:bg-gray-50"
          >Next</button>
        </div>
      )}
    </div>
  );
}
