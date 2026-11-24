import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useIsDark } from '@ui/contexts/ThemeContext';
import { tagPillStyle } from '@ui/utils/colors';
import useFeatures from '@ui/hooks/useFeatures';
import EntityDetailPage from './EntityDetailPage';
import RiskScoreSection from './RiskScoreSection';
import AccessPackageGovernance from './AccessPackageGovernance';
import DeletedBadge from './DeletedBadge';
import BusinessRoleOverview from './businessRoles/BusinessRoleOverview';
import BusinessRoleResources from './businessRoles/BusinessRoleResources';
import BusinessRoleMembers from './businessRoles/BusinessRoleMembers';
import WayChips from './businessRoles/WayChips';
import { showsRequestsAndReviews } from './businessRoles/accessModel';
import { buildAttributeEntries } from '@ui/utils/attributeEntries';
import { formatDate } from '@ui/utils/formatters';

const HEADER_FIELDS = ['catalogName', 'catalogId', 'description'];
const HIDDEN_FIELDS = new Set([
  'displayName', ...HEADER_FIELDS, 'ValidFrom', 'ValidTo', 'extendedAttributes',
]);

async function fetchAccessPackageData({ entityId, authFetch }) {
  const r = await authFetch(`/api/access-package/${encodeURIComponent(entityId)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function getAccessPackageAttributeEntries(data) {
  const { attributes } = data;
  const extAttrs = attributes.extendedAttributesParsed ||
    (typeof attributes.extendedAttributes === 'object' ? attributes.extendedAttributes : null);
  return buildAttributeEntries(attributes, extAttrs, HIDDEN_FIELDS);
}

function getAccessPackageRootExtras(data) {
  return {
    catalogId: data.attributes?.catalogId,
    catalogName: data.attributes?.catalogName,
    recent: null,
  };
}

function AccessPackageHeader({ data }) {
  const isDark = useIsDark();
  const { attributes, accessModel, category, lastReviewDate, lastReviewedBy } = data;
  return (
    <>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center justify-center text-lg font-bold">BR</div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{attributes.displayName}</h2>
            {category && (
              <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium border"
                style={tagPillStyle(category.color, isDark)}>
                {category.name}
              </span>
            )}
            {attributes.deletedAt && <DeletedBadge at={attributes.deletedAt} label="Deleted in source" />}
          </div>
          {attributes.catalogName && (
            <p className="text-sm text-gray-500 dark:text-gray-400">Catalog: {attributes.catalogName}</p>
          )}
        </div>
      </div>
      {attributes.description && (
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 max-w-2xl">{attributes.description}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400" data-testid="role-access-model">
        <WayChips ways={[accessModel?.control ?? 'Unknown']} direction="control" />
        <span className="inline-flex items-center gap-1">Gained by <WayChips ways={accessModel?.waysIn} direction="in" /></span>
        <span className="inline-flex items-center gap-1">Lost by <WayChips ways={accessModel?.waysOut} direction="out" none="no automatic removal" /></span>
      </div>
      {lastReviewDate && (
        <div className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          <span className="text-gray-500 dark:text-gray-400">Last Certification:</span>{' '}
          <span className="font-medium">{formatDate(lastReviewDate)}</span>
          {lastReviewedBy && <span className="text-gray-500 dark:text-gray-400"> by {lastReviewedBy}</span>}
        </div>
      )}
    </>
  );
}

export default function AccessPackageDetailPage({ accessPackageId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const features = useFeatures();
  const [riskData, setRiskData] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/risk-scores/business-roles/${accessPackageId}`);
        if (res.ok) setRiskData(await res.json());
      } catch { /* risk data optional */ }
    })();
  }, [authFetch, accessPackageId]);

  const getTabs = useCallback((data, entries) => {
    const hasRisk = features.riskScoring && riskData && riskData.riskScore != null;
    return [
      { key: 'overview', label: 'Overview' },
      { key: 'resources', label: 'Resources', count: data.groupCount ?? 0 },
      { key: 'members', label: 'People', count: data.assignmentCount ?? 0 },
      showsRequestsAndReviews(data) && { key: 'requests', label: 'Requests & reviews', count: data.pendingRequestCount || undefined },
      { key: 'attributes', label: 'Attributes', count: entries.length },
      { key: 'relationships', label: 'Relationships' },
      { key: 'timeline', label: 'Timeline' },
      { key: 'diff', label: 'Diff' },
      hasRisk && { key: 'risk', label: 'Risk' },
    ];
  }, [features, riskData]);

  const renderCustomTab = useCallback((key, data, openTab) => {
    if (key === 'overview') return <BusinessRoleOverview roleId={accessPackageId} data={data} onOpenDetail={onOpenDetail} onOpenTab={openTab} />;
    if (key === 'resources') return <BusinessRoleResources roleId={accessPackageId} onOpenDetail={onOpenDetail} />;
    if (key === 'members') return <BusinessRoleMembers roleId={accessPackageId} control={data.accessModel?.control} onOpenDetail={onOpenDetail} />;
    if (key === 'requests') return <AccessPackageGovernance accessPackageId={accessPackageId} authFetch={authFetch} showPolicies={false} />;
    return null;
  }, [accessPackageId, authFetch, onOpenDetail]);

  return (
    <EntityDetailPage
      entityKind="access-package"
      entityId={accessPackageId}
      authFetch={authFetch}
      fetchData={fetchAccessPackageData}
      cachedData={cachedData}
      onCacheData={onCacheData}
      getGraphRootExtras={getAccessPackageRootExtras}
      graphCenterLabel="Business Role"
      getTabs={getTabs}
      initialTab="overview"
      renderCustomTab={renderCustomTab}
      getAttributeEntries={getAccessPackageAttributeEntries}
      renderHeader={(data) => <AccessPackageHeader data={data} />}
      renderRisk={riskData ? () => (
        <RiskScoreSection attributes={riskData} entityType="business-roles" entityId={accessPackageId} authFetch={authFetch} />
      ) : undefined}
      entityLabel="business role"
      onClose={onClose}
      onOpenDetail={onOpenDetail}
    />
  );
}
