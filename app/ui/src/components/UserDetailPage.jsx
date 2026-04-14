import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection, { RISK_FIELDS } from './RiskScoreSection';
import { formatDate, formatValue, computeHistoryDiffs, friendlyLabel } from '../utils/formatters';
import { tierClass } from '../utils/tierStyles';
import { Section, CollapsibleSection } from './DetailSection';

const HEADER_FIELDS = ['userPrincipalName', 'email', 'department', 'jobTitle', 'companyName'];
const HIDDEN_FIELDS = new Set(['displayName', ...HEADER_FIELDS, ...RISK_FIELDS, 'ValidFrom', 'ValidTo', 'extendedAttributes', 'extendedAttributesParsed']);

export default function UserDetailPage({ userId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();

  // Core data (fast — attributes, tags, counts)
  const [data, setData] = useState(cachedData?.core || null);
  const [loading, setLoading] = useState(!cachedData?.core);
  const [error, setError] = useState(null);

  // Lazy-loaded history
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState(cachedData?.history || null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Identity membership
  const [identityInfo, setIdentityInfo] = useState(undefined); // undefined = not fetched, null = no identity

  // Manager and direct reports
  const [manager, setManager] = useState(null);
  const [managerLoaded, setManagerLoaded] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(false);
  const [reports, setReports] = useState(null);
  const [reportsLoading, setReportsLoading] = useState(false);

  // Fetch core data (attributes + tags + counts)
  useEffect(() => {
    if (cachedData?.core) return; // Already cached
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(`/api/user/${encodeURIComponent(userId)}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        if (!cancelled) {
          setData(d);
          onCacheData?.(userId, 'user', { core: d });
        }
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId, authFetch, cachedData?.core, onCacheData]);

  // Fetch identity membership
  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/identities/by-user/${encodeURIComponent(userId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setIdentityInfo(d?.identity ? d : null); })
      .catch(() => { if (!cancelled) setIdentityInfo(null); });
    return () => { cancelled = true; };
  }, [userId, authFetch]);

  // Fetch manager (lightweight — one record)
  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/org-chart/user/${encodeURIComponent(userId)}/manager`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d?.manager) setManager(d.manager); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setManagerLoaded(true); });
    return () => { cancelled = true; };
  }, [userId, authFetch]);

  // Lazy-load direct reports
  const loadReports = useCallback(() => {
    if (reports) return;
    setReportsLoading(true);
    authFetch(`/api/org-chart/user/${encodeURIComponent(userId)}/reports`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setReports(d?.reports || []))
      .catch(() => setReports([]))
      .finally(() => setReportsLoading(false));
  }, [userId, authFetch, reports]);

  const toggleReports = useCallback(() => {
    setReportsOpen(prev => {
      if (!prev) loadReports();
      return !prev;
    });
  }, [loadReports]);

  // Lazy-load history
  const loadHistory = useCallback(() => {
    if (history) return;
    setHistoryLoading(true);
    authFetch(`/api/user/${encodeURIComponent(userId)}/history`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setHistory(d);
        onCacheData?.(userId, 'user', { history: d });
      })
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [userId, authFetch, history, onCacheData]);

  const toggleHistory = useCallback(() => {
    setHistoryOpen(prev => {
      if (!prev) loadHistory();
      return !prev;
    });
  }, [loadHistory]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading user details...</div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h2 className="text-red-800 font-semibold">Error loading user</h2>
        <p className="text-red-600 mt-1 text-sm">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const { attributes, tags, historyCount, hasHistory, lastActivity } = data;
  const resolvedHistoryCount = history ? history.length : historyCount;
  const otherAttributes = [['id', attributes.id], ...Object.entries(attributes).filter(([k]) => !HIDDEN_FIELDS.has(k) && k !== 'id')];
  const isEntraSystem = (attributes.systemDisplayName || '').toLowerCase().includes('entra') ||
    (attributes.systemDisplayName || '').toLowerCase().includes('azure ad') ||
    (attributes.principalType || '').startsWith('Entra');
  const entraUrl = isEntraSystem
    ? `https://entra.microsoft.com/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${encodeURIComponent(userId)}`
    : null;

  const historyDiffs = history ? computeHistoryDiffs(history) : [];

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-lg font-bold">
              {(attributes.displayName || '?')[0]}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold text-gray-900">{attributes.displayName}</h2>
                {attributes.principalType && (
                  <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800 border border-indigo-200">
                    {attributes.principalType}
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-500">{attributes.userPrincipalName || attributes.email}</p>
              {(attributes.systemDisplayName || attributes.systemId) && (
                <p className="text-xs text-gray-400">System: {attributes.systemDisplayName || attributes.systemId}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-600">
            {attributes.jobTitle && <span>{attributes.jobTitle}</span>}
            {attributes.department && <span className="text-gray-400">|</span>}
            {attributes.department && <span>{attributes.department}</span>}
            {attributes.companyName && <span className="text-gray-400">|</span>}
            {attributes.companyName && <span>{attributes.companyName}</span>}
          </div>
          {lastActivity?.lastActivityDateTime && (
            <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-400">
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Last sign-in: {formatDate(lastActivity.lastActivityDateTime)}</span>
            </div>
          )}
          {tags.length > 0 && (
            <div className="flex gap-1.5 mt-2">
              {tags.map(t => (
                <span key={t.id} className="inline-block px-2 py-0.5 rounded-full text-xs font-medium border"
                  style={{ backgroundColor: t.color + '20', borderColor: t.color, color: t.color }}>
                  {t.name}
                </span>
              ))}
            </div>
          )}
          {entraUrl && (
            <a href={entraUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-2 text-xs text-blue-600 hover:text-blue-800 hover:underline">
              Open in Entra ID
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          )}
        </div>
        <button onClick={onClose}
          className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
          title="Close tab">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Risk Assessment */}
      <RiskScoreSection attributes={attributes} entityType="user" entityId={userId} authFetch={authFetch} />

      {/* Identity Membership */}
      {identityInfo && <IdentityMembershipSection identityInfo={identityInfo} onNavigateToIdentities={() => { window.location.hash = 'identities'; }} />}

      {/* Manager */}
      {managerLoaded && manager && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mt-4 mb-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Manager</h3>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-bold shrink-0">
              {(manager.displayName || '?')[0]}
            </div>
            <div className="min-w-0 flex-1">
              <button
                onClick={() => onOpenDetail?.('user', manager.id, manager.displayName)}
                className="text-sm font-medium text-blue-700 hover:text-blue-900 hover:underline text-left"
              >
                {manager.displayName}
              </button>
              <div className="text-xs text-gray-400">
                {[manager.jobTitle, manager.department].filter(Boolean).join(' \u2022 ') || '\u2014'}
              </div>
            </div>
            {manager.riskTier && manager.riskTier !== 'None' && manager.riskTier !== 'Minimal' && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${tierClass(manager.riskTier)}`}>
                {manager.riskTier}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Direct Reports */}
      {managerLoaded && (
        <div className="mb-4">
          <CollapsibleSection
            title="Direct Reports"
            count={attributes.riskHierarchyDirectReports || null}
            open={reportsOpen}
            onToggle={toggleReports}
            loading={reportsLoading}
          >
            {reports && reports.length === 0 ? (
              <p className="text-sm text-gray-400 italic p-4">No direct reports</p>
            ) : reports ? (
              <div className="divide-y divide-gray-50">
                {reports.map(r => (
                  <div key={r.id} className="flex items-center gap-3 px-4 py-2 hover:bg-gray-50">
                    <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0">
                      {(r.displayName || '?')[0]}
                    </div>
                    <div className="min-w-0 flex-1">
                      <button
                        onClick={() => onOpenDetail?.('user', r.id, r.displayName)}
                        className="text-sm font-medium text-blue-700 hover:text-blue-900 hover:underline text-left"
                      >
                        {r.displayName}
                      </button>
                      <div className="text-xs text-gray-400">
                        {[r.jobTitle, r.department].filter(Boolean).join(' \u2022 ') || '\u2014'}
                      </div>
                    </div>
                    {r.riskTier && r.riskTier !== 'None' && r.riskTier !== 'Minimal' && (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${tierClass(r.riskTier)}`}>
                        {r.riskTier}
                      </span>
                    )}
                    {r.riskScore != null && (
                      <span className="text-xs font-mono text-gray-400 w-6 text-right">{r.riskScore}</span>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </CollapsibleSection>
        </div>
      )}

      {/* Attributes - single column table */}
      <Section title="Attributes" count={otherAttributes.length}>
        <table className="w-full text-sm">
          <tbody>
            {otherAttributes.map(([key, val]) => (
              <tr key={key} className="border-b border-gray-50 last:border-b-0">
                <td className="py-1 pr-4 text-gray-500 whitespace-nowrap align-top">{friendlyLabel(key)}</td>
                <td className="py-1 text-gray-900 font-medium break-all">{formatValue(val)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Extended Attributes (Principals model) */}
      {attributes.extendedAttributesParsed && Object.keys(attributes.extendedAttributesParsed).length > 0 && (
        <div className="mt-4">
          <Section title="Extended Attributes" count={Object.keys(attributes.extendedAttributesParsed).filter(k => attributes.extendedAttributesParsed[k] != null).length}>
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(attributes.extendedAttributesParsed)
                  .filter(([, val]) => val != null)
                  .map(([key, val]) => (
                    <tr key={key} className="border-b border-gray-50 last:border-b-0">
                      <td className="py-1 pr-4 text-gray-500 whitespace-nowrap align-top">{friendlyLabel(key)}</td>
                      <td className="py-1 text-gray-900 font-medium break-all">{formatValue(val)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Section>
        </div>
      )}

      {/* Version History - collapsible, lazy-loaded */}
      <div className="mt-6">
        <CollapsibleSection
          title="Version History"
          count={resolvedHistoryCount}
          countLabel={resolvedHistoryCount === 1 ? 'version' : 'versions'}
          open={historyOpen}
          onToggle={toggleHistory}
          loading={historyLoading}
        >
          {historyDiffs.length === 0 ? (
            <p className="text-sm text-gray-400 italic p-4">No changes recorded</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 font-medium w-44">Date</th>
                  <th className="px-4 py-2 font-medium">Changes</th>
                </tr>
              </thead>
              <tbody>
                {historyDiffs.map((diff, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="px-4 py-2 text-gray-600 text-xs align-top whitespace-nowrap">
                      {formatDate(diff.date)}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-col gap-1">
                        {diff.changes.map((c, j) => (
                          <div key={j} className="text-xs">
                            <span className="font-medium text-gray-700">{friendlyLabel(c.field)}</span>
                            <span className="text-gray-400 mx-1">:</span>
                            <span className="text-red-500 line-through mr-1">{c.from}</span>
                            <span className="text-gray-400 mr-1">&rarr;</span>
                            <span className="text-green-600">{c.to}</span>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>
      </div>
    </div>
  );
}

const ACCOUNT_TYPE_COLORS = {
  Regular:  'bg-blue-100 text-blue-800 border-blue-200',
  Admin:    'bg-red-100 text-red-800 border-red-200',
  Test:     'bg-amber-100 text-amber-800 border-amber-200',
  Service:  'bg-purple-100 text-purple-800 border-purple-200',
  Shared:   'bg-teal-100 text-teal-800 border-teal-200',
  External: 'bg-gray-100 text-gray-600 border-gray-200',
};

function IdentityMembershipSection({ identityInfo, onNavigateToIdentities }) {
  const [expanded, setExpanded] = useState(false);
  const { identity, memberInfo, otherMembers = [] } = identityInfo;
  const typeColor = ACCOUNT_TYPE_COLORS[memberInfo.accountType] || ACCOUNT_TYPE_COLORS.Regular;

  return (
    <div className="bg-white border border-emerald-200 rounded-lg p-4 mt-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <svg className="w-4 h-4 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" />
          </svg>
          Identity Membership
        </h3>
        <button
          onClick={onNavigateToIdentities}
          className="text-xs text-emerald-700 hover:text-emerald-900 hover:underline"
        >
          View all identities →
        </button>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900 text-sm">{identity.displayName}</span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${typeColor}`}>
              {memberInfo.accountType}
            </span>
            {memberInfo.isPrimary && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">Primary</span>
            )}
            {memberInfo.isHrAuthoritative && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-200" title={`HR Score: ${memberInfo.hrScore}`}>HR Source</span>
            )}
            {memberInfo.analystOverride && (
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium ${
                memberInfo.analystOverride === 'confirmed' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
              }`}>{memberInfo.analystOverride}</span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {identity.accountCount} account{identity.accountCount !== 1 ? 's' : ''} · primary: {identity.primaryAccountUpn}
            {identity.correlationConfidence != null && ` · ${identity.correlationConfidence}% confidence`}
          </div>
          {memberInfo.correlationSignals && (
            <div className="text-xs text-gray-400 mt-0.5">
              Signals: {memberInfo.correlationSignals}
            </div>
          )}
        </div>
      </div>

      {otherMembers.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
          >
            <span>{expanded ? '▼' : '▶'}</span>
            {expanded ? 'Hide' : 'Show'} other accounts ({otherMembers.length})
          </button>
          {expanded && (
            <div className="mt-2 space-y-1 border-t border-gray-100 pt-2">
              {otherMembers.map(m => {
                const tc = ACCOUNT_TYPE_COLORS[m.accountType] || ACCOUNT_TYPE_COLORS.Regular;
                return (
                  <div key={m.userId} className="flex items-center gap-2 text-xs">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full font-medium border ${tc}`}>{m.accountType}</span>
                    {m.isPrimary && <span className="text-blue-600 font-medium">Primary</span>}
                    {m.isHrAuthoritative && <span className="text-emerald-700 font-medium">HR</span>}
                    <span className="text-gray-700 font-medium truncate max-w-48">{m.displayName}</span>
                    <span className="text-gray-400 truncate max-w-64">{m.userPrincipalName}</span>
                    <span className={`ml-auto ${m.accountEnabled === 'True' || m.accountEnabled === true ? 'text-green-500' : 'text-gray-300'}`}>
                      {m.accountEnabled === 'True' || m.accountEnabled === true ? '●' : '○'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

