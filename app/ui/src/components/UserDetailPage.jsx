import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import useFeatures from '@ui/hooks/useFeatures';
import EntityDetailPage from './EntityDetailPage';
import RiskScoreSection from './RiskScoreSection';
import { RISK_FIELDS } from './RiskScoreSection.constants.js';
import DeletedBadge from './DeletedBadge';
import { buildAttributeEntries } from '@ui/utils/attributeEntries';
import { formatDate } from '@ui/utils/formatters';

const ACCOUNT_TYPE_COLORS = {
  Member:           'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 border-blue-200 dark:border-blue-700',
  Guest:            'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-700',
  ServicePrincipal: 'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300 border-purple-200 dark:border-purple-700',
  Application:      'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300 border-purple-200 dark:border-purple-700',
  ManagedIdentity:  'bg-teal-100 dark:bg-teal-900/30 text-teal-800 dark:text-teal-300 border-teal-200 dark:border-teal-700',
  Deleted:          'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300 border-red-200 dark:border-red-700',
};
const ACCOUNT_TYPE_COLORS_DEFAULT = 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700';

const HEADER_FIELDS = ['userPrincipalName', 'email', 'department', 'jobTitle', 'companyName'];
const HIDDEN_FIELDS = new Set([
  'displayName', ...HEADER_FIELDS, ...RISK_FIELDS,
  'ValidFrom', 'ValidTo', 'extendedAttributes', 'extendedAttributesParsed',
  'managerId', 'contextId',
]);

async function fetchUserData({ entityId, authFetch }) {
  const r = await authFetch(`/api/user/${encodeURIComponent(entityId)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function getUserAttributeEntries(data) {
  return buildAttributeEntries(data.attributes, data.attributes.extendedAttributesParsed, HIDDEN_FIELDS);
}

function UserHeader({ data }) {
  const { attributes, tags, lastActivity } = data;
  const typeClass = ACCOUNT_TYPE_COLORS[attributes.principalType] || ACCOUNT_TYPE_COLORS_DEFAULT;
  return (
    <>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center justify-center text-lg font-bold">
          {(attributes.displayName || '?')[0]}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{attributes.displayName}</h2>
            {attributes.principalType && (
              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${typeClass}`}>
                {attributes.principalType}
              </span>
            )}
            {attributes.deletedAt && <DeletedBadge at={attributes.deletedAt} label="Deleted in source" />}
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">{attributes.userPrincipalName || attributes.email}</p>
          {(attributes.systemDisplayName || attributes.systemId) && (
            <p className="text-xs text-gray-600 dark:text-gray-500">System: {attributes.systemDisplayName || attributes.systemId}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4 mt-2 text-sm text-gray-600 dark:text-gray-400">
        {attributes.jobTitle && <span>{attributes.jobTitle}</span>}
        {attributes.department && <span className="text-gray-600 dark:text-gray-500">|</span>}
        {attributes.department && <span>{attributes.department}</span>}
        {attributes.companyName && <span className="text-gray-600 dark:text-gray-500">|</span>}
        {attributes.companyName && <span>{attributes.companyName}</span>}
      </div>
      {lastActivity?.lastActivityDateTime && (
        <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-600 dark:text-gray-500">
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>Last sign-in: {formatDate(lastActivity.lastActivityDateTime)}</span>
        </div>
      )}
      {tags?.length > 0 && (
        <div className="flex gap-1.5 mt-2">
          {tags.map(t => (
            <span key={t.id} className="inline-block px-2 py-0.5 rounded-full text-xs font-medium border"
              style={{ backgroundColor: t.color + '20', borderColor: t.color, color: t.color }}>
              {t.name}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

export default function UserDetailPage({ userId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const features = useFeatures();
  const [identityInfo, setIdentityInfo] = useState(undefined);
  const [manager, setManager] = useState(null);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/identities/by-user/${encodeURIComponent(userId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setIdentityInfo(d?.identity ? d : null); })
      .catch(() => { if (!cancelled) setIdentityInfo(null); });
    return () => { cancelled = true; };
  }, [userId, authFetch]);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/org-chart/user/${encodeURIComponent(userId)}/manager`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d?.manager) setManager(d.manager); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [userId, authFetch]);

  const getGraphRootExtras = useCallback((data) => ({
    manager,
    identityInfo,
    // The agent's enterprise-app Resource (same id) — powers the "Linked
    // Resource" relations node so its Principal and Resource views cross-link.
    linkedResource: data?.linkedResource,
    contextId: data?.attributes?.contextId,
    recent: null,
  }), [manager, identityInfo]);

  const getTabs = useCallback((data, entries) => [
    { key: 'attributes', label: 'Attributes', count: entries.length },
    { key: 'relationships', label: 'Relationships' },
    { key: 'timeline', label: 'Timeline' },
    (features.riskScoring && data.attributes.riskScore != null) && { key: 'risk', label: 'Risk' },
  ], [features]);

  return (
    <EntityDetailPage
      entityKind="user"
      entityId={userId}
      authFetch={authFetch}
      fetchData={fetchUserData}
      cachedData={cachedData}
      onCacheData={onCacheData}
      getGraphRootExtras={getGraphRootExtras}
      graphCenterLabel="User"
      getTabs={getTabs}
      getAttributeEntries={getUserAttributeEntries}
      renderHeader={(data) => <UserHeader data={data} />}
      renderRisk={(data) => (
        <RiskScoreSection attributes={data.attributes} entityType="user" entityId={userId} authFetch={authFetch} />
      )}
      entityLabel="user"
      onClose={onClose}
      onOpenDetail={onOpenDetail}
    />
  );
}
