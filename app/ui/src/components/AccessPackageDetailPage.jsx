import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useIsDark } from '@ui/contexts/ThemeContext';
import { tagPillStyle } from '@ui/utils/colors';
import useFeatures from '@ui/hooks/useFeatures';
import { useFeatureFlags } from '@ui/contexts/FeaturesContext';
import { useAnswersForRole } from '@ui/contexts/ContextOwnerScopeContext';
import EntityDetailPage from './EntityDetailPage';
import RiskScoreSection from './RiskScoreSection';
import AccessPackageGovernance from './AccessPackageGovernance';
import DeletedBadge from './DeletedBadge';
import BusinessRoleOverview from './businessRoles/BusinessRoleOverview';
import BusinessRoleLifecycle from './businessRoles/BusinessRoleLifecycle';
import BusinessRoleResources from './businessRoles/BusinessRoleResources';
import BusinessRoleMembers from './businessRoles/BusinessRoleMembers';
import BusinessRoleCompositionReview from './businessRoles/BusinessRoleCompositionReview';
import { useIsSharedView } from '@ui/contexts/SharedViewContext';
import WayChips from './businessRoles/WayChips';
import { showsRequestsAndReviews } from './businessRoles/accessModel';
import { buildAttributeEntries } from '@ui/utils/attributeEntries';

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

function AccessPackageHeader({ data, onOpenDetail }) {
  const isDark = useIsDark();
  const { attributes, accessModel, category } = data;
  return (
    <>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center justify-center text-lg font-bold">BR</div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{attributes.displayName}</h2>
            <span data-testid="role-type"><WayChips ways={[accessModel?.control ?? 'Unknown']} direction="control" /></span>
            {category && (
              <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium border"
                style={tagPillStyle(category.color, isDark)}>
                {category.name}
              </span>
            )}
            {attributes.deletedAt && <DeletedBadge at={attributes.deletedAt} label="Deleted in source" />}
          </div>
          {attributes.catalogName && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Role portfolio:{' '}
              {attributes.catalogId && onOpenDetail ? (
                <button type="button" onClick={() => onOpenDetail('context', attributes.catalogId, attributes.catalogName)}
                  className="text-blue-700 hover:underline dark:text-blue-300">{attributes.catalogName}</button>
              ) : attributes.catalogName}
            </p>
          )}
        </div>
      </div>
      {attributes.description && (
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 max-w-2xl">{attributes.description}</p>
      )}
    </>
  );
}

export default function AccessPackageDetailPage({ accessPackageId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const features = useFeatures();
  const sharedView = useIsSharedView();
  const compositionReview = useFeatureFlags().compositionReview === true;
  // A context owner who answers for this role reviews it from their own page.
  const answersForRole = useAnswersForRole(accessPackageId);
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
      { key: 'lifecycle', label: 'Lifecycle' },
      // Experimental (flag compositionReview). Not part of a shared view, except
      // for a context owner who answers for the role.
      compositionReview && (!sharedView || answersForRole) && { key: 'composition', label: 'Composition review' },
      { key: 'resources', label: 'Resources', count: data.groupCount ?? 0 },
      { key: 'members', label: 'People', count: data.assignmentCount ?? 0 },
      showsRequestsAndReviews(data) && { key: 'requests', label: 'Requests & reviews', count: data.pendingRequestCount || undefined },
      { key: 'attributes', label: 'Attributes', count: entries.length },
      { key: 'relationships', label: 'Relationships' },
      { key: 'timeline', label: 'Timeline' },
      { key: 'diff', label: 'Diff' },
      hasRisk && { key: 'risk', label: 'Risk' },
    ];
  }, [features, riskData, sharedView, compositionReview, answersForRole]);

  const renderCustomTab = useCallback((key, data, openTab) => {
    if (key === 'overview') return <BusinessRoleOverview roleId={accessPackageId} data={data} onOpenDetail={onOpenDetail} onOpenTab={openTab} />;
    if (key === 'lifecycle') return <BusinessRoleLifecycle roleId={accessPackageId} data={data} onOpenDetail={onOpenDetail} />;
    if (key === 'composition') return <BusinessRoleCompositionReview roleId={accessPackageId} onOpenTab={openTab} answersForRole={answersForRole} />;
    if (key === 'resources') return <BusinessRoleResources roleId={accessPackageId} onOpenDetail={onOpenDetail} />;
    if (key === 'members') return <BusinessRoleMembers roleId={accessPackageId} control={data.accessModel?.control} onOpenDetail={onOpenDetail} />;
    if (key === 'requests') return <AccessPackageGovernance accessPackageId={accessPackageId} authFetch={authFetch} showPolicies={false} />;
    return null;
  }, [accessPackageId, authFetch, onOpenDetail, answersForRole]);

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
      // An owner reviewing a role they answer for starts where they act.
      initialTab={answersForRole ? 'composition' : 'overview'}
      renderCustomTab={renderCustomTab}
      getAttributeEntries={getAccessPackageAttributeEntries}
      renderHeader={(data) => <AccessPackageHeader data={data} onOpenDetail={onOpenDetail} />}
      renderRisk={riskData ? () => (
        <RiskScoreSection attributes={riskData} entityType="business-roles" entityId={accessPackageId} authFetch={authFetch} />
      ) : undefined}
      entityLabel="business role"
      onClose={onClose}
      onOpenDetail={onOpenDetail}
    />
  );
}
