import { useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import useFeatures from '@ui/hooks/useFeatures';
import EntityDetailPage from './EntityDetailPage';
import RiskScoreSection from './RiskScoreSection';
import { RISK_FIELDS } from './RiskScoreSection.constants.js';
import DeletedBadge from './DeletedBadge';
import { buildAttributeEntries } from '@ui/utils/attributeEntries';

import { RESOURCE_TYPE_COLORS } from './ResourceDetailPage.constants.js';

const HEADER_FIELDS = ['description', 'resourceType', 'groupTypeCalculated'];
const HIDDEN_FIELDS = new Set([
  'displayName', ...HEADER_FIELDS, ...RISK_FIELDS,
  'ValidFrom', 'ValidTo', 'extendedAttributes', 'systemId', 'contextId',
]);

function parseExtendedAttributes(val) {
  if (!val) return null;
  if (typeof val === 'object' && !Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return null; }
}

async function fetchResourceData({ entityId, authFetch }) {
  const r = await authFetch(`/api/resources/${encodeURIComponent(entityId)}`);
  if (!r.ok) {
    const r2 = await authFetch(`/api/group/${encodeURIComponent(entityId)}`);
    if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
    return r2.json();
  }
  return r.json();
}

function getResourceAttributeEntries(data) {
  const extAttrs = parseExtendedAttributes(data.attributes.extendedAttributes);
  return buildAttributeEntries(data.attributes, extAttrs, HIDDEN_FIELDS);
}

function getResourceRootExtras(data) {
  return { contextId: data.attributes?.contextId, recent: null };
}

function ResourceHeader({ data }) {
  const { attributes, tags } = data;
  const resourceType = attributes.resourceType || attributes.groupTypeCalculated || '';
  const typeBadgeClass = RESOURCE_TYPE_COLORS[resourceType] || 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300';
  return (
    <>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 flex items-center justify-center text-lg font-bold">R</div>
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{attributes.displayName}</h2>
          <div className="flex items-center gap-2 mt-0.5">
            {resourceType && (
              <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${typeBadgeClass}`}>{resourceType}</span>
            )}
            {attributes.deletedAt && <DeletedBadge at={attributes.deletedAt} label="Deleted in source" />}
            {attributes.systemId && (
              <span className="text-xs text-gray-600 dark:text-gray-500">System: {attributes.systemId}</span>
            )}
          </div>
        </div>
      </div>
      {attributes.description && (
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 max-w-2xl">{attributes.description}</p>
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

export default function ResourceDetailPage({ resourceId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const features = useFeatures();

  const getTabs = useCallback((data, entries) => [
    { key: 'attributes', label: 'Attributes', count: entries.length },
    { key: 'relationships', label: 'Relationships' },
    { key: 'timeline', label: 'Timeline' },
    (features.riskScoring && data.attributes.riskScore != null) && { key: 'risk', label: 'Risk' },
  ], [features]);

  return (
    <EntityDetailPage
      entityKind="resource"
      entityId={resourceId}
      authFetch={authFetch}
      fetchData={fetchResourceData}
      cachedData={cachedData}
      onCacheData={onCacheData}
      getGraphRootExtras={getResourceRootExtras}
      graphCenterLabel="Resource"
      getTabs={getTabs}
      getAttributeEntries={getResourceAttributeEntries}
      renderHeader={(data) => <ResourceHeader data={data} />}
      renderRisk={(data) => (
        <RiskScoreSection attributes={data.attributes} entityType="group" entityId={resourceId} authFetch={authFetch} />
      )}
      entityLabel="resource"
      onClose={onClose}
      onOpenDetail={onOpenDetail}
    />
  );
}
