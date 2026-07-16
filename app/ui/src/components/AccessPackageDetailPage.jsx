import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useIsDark } from '@ui/contexts/ThemeContext';
import { tagPillStyle } from '@ui/utils/colors';
import useFeatures from '@ui/hooks/useFeatures';
import EntityDetailPage from './EntityDetailPage';
import RiskScoreSection from './RiskScoreSection';
import AccessPackageGovernance from './AccessPackageGovernance';
import { buildAttributeEntries } from '@ui/utils/attributeEntries';
import { formatDate } from '@ui/utils/formatters';
import { ASSIGNMENT_TYPE_STYLES, COMPLIANCE_STYLES } from '@ui/utils/accessPackageStyles';

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
  const { attributes, assignmentType, category, lastReviewDate, lastReviewedBy } = data;
  return (
    <>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center justify-center text-lg font-bold">BR</div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{attributes.displayName}</h2>
            {assignmentType && (
              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${ASSIGNMENT_TYPE_STYLES[assignmentType] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                {assignmentType}
              </span>
            )}
            {category && (
              <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium border"
                style={tagPillStyle(category.color, isDark)}>
                {category.name}
              </span>
            )}
          </div>
          {attributes.catalogName && (
            <p className="text-sm text-gray-500 dark:text-gray-400">Catalog: {attributes.catalogName}</p>
          )}
        </div>
      </div>
      {attributes.description && (
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 max-w-2xl">{attributes.description}</p>
      )}
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

// ─── Overview — the list's calculated fields, with the same badges/colours ──
function OverviewRow({ label, children }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5 border-b border-gray-50 dark:border-gray-700/50 last:border-b-0">
      <span className="text-xs text-gray-500 dark:text-gray-400 w-32 shrink-0">{label}</span>
      <span className="text-sm text-gray-900 dark:text-gray-100">{children}</span>
    </div>
  );
}

const BADGE = 'inline-block px-2 py-0.5 rounded-full text-xs font-medium border';
const NEUTRAL = 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600';

function OverviewPanel({ assignmentType, complianceStatus, daysOverdue, lastReviewDate, lastReviewedBy, category }) {
  const isDark = useIsDark();
  if (!(assignmentType || complianceStatus || lastReviewDate || lastReviewedBy || category)) return null;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Overview</h3>
      </div>
      <div className="px-4 py-2">
        {assignmentType && (
          <OverviewRow label="Type">
            <span className={`${BADGE} ${ASSIGNMENT_TYPE_STYLES[assignmentType] || NEUTRAL}`}>{assignmentType}</span>
          </OverviewRow>
        )}
        {complianceStatus && (
          <OverviewRow label="Review status">
            <span className={`${BADGE} ${COMPLIANCE_STYLES[complianceStatus] || NEUTRAL}`}>
              {complianceStatus}{daysOverdue ? ` (${daysOverdue}d ago)` : ''}
            </span>
          </OverviewRow>
        )}
        {lastReviewDate && <OverviewRow label="Review date">{formatDate(lastReviewDate)}</OverviewRow>}
        {lastReviewedBy && <OverviewRow label="Reviewed by">{lastReviewedBy}</OverviewRow>}
        {category && (
          <OverviewRow label="Category">
            <span className={BADGE} style={tagPillStyle(category.color, isDark)}>{category.name}</span>
          </OverviewRow>
        )}
      </div>
    </div>
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
      { key: 'attributes', label: 'Attributes', count: entries.length },
      { key: 'relationships', label: 'Relationships' },
      { key: 'timeline', label: 'Timeline' },
      hasRisk && { key: 'risk', label: 'Risk' },
    ];
  }, [features, riskData]);

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
      getAttributeEntries={getAccessPackageAttributeEntries}
      renderHeader={(data) => <AccessPackageHeader data={data} />}
      renderAttributesBefore={(data) => (
        <OverviewPanel
          assignmentType={data.assignmentType}
          complianceStatus={data.complianceStatus}
          daysOverdue={data.daysOverdue}
          lastReviewDate={data.lastReviewDate}
          lastReviewedBy={data.lastReviewedBy}
          category={data.category}
        />
      )}
      renderAttributesExtra={() => (
        <AccessPackageGovernance accessPackageId={accessPackageId} authFetch={authFetch} />
      )}
      renderRisk={riskData ? () => (
        <RiskScoreSection attributes={riskData} entityType="business-roles" entityId={accessPackageId} authFetch={authFetch} />
      ) : undefined}
      entityLabel="business role"
      onClose={onClose}
      onOpenDetail={onOpenDetail}
    />
  );
}
