import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection, { RISK_FIELDS } from './RiskScoreSection';
import { formatDate, formatValue, computeHistoryDiffs, friendlyLabel } from '../utils/formatters';

const RESOURCE_TYPE_COLORS = {
  EntraGroup: 'bg-blue-100 text-blue-700',
  EntraAppRole: 'bg-purple-100 text-purple-700',
  EntraDirectoryRole: 'bg-orange-100 text-orange-700',
  EntraAdminUnit: 'bg-teal-100 text-teal-700',
};

const HEADER_FIELDS = ['description', 'resourceType', 'groupTypeCalculated'];
const HIDDEN_FIELDS = new Set(['displayName', ...HEADER_FIELDS, ...RISK_FIELDS, 'ValidFrom', 'ValidTo', 'extendedAttributes', 'systemId']);

function parseExtendedAttributes(val) {
  if (!val) return null;
  if (typeof val === 'object' && !Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return null; }
}

const ASSIGNMENT_TYPE_COLORS = {
  Direct: 'bg-green-100 text-green-700',
  Governed: 'bg-blue-100 text-blue-700',
  Owner: 'bg-amber-100 text-amber-700',
  Eligible: 'bg-purple-100 text-purple-700',
};

export default function ResourceDetailPage({ resourceId, cachedData, onCacheData, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();

  // Core data
  const [data, setData] = useState(cachedData?.core || null);
  const [loading, setLoading] = useState(!cachedData?.core);
  const [error, setError] = useState(null);

  // Lazy-loaded sections
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);
  const [assignments, setAssignments] = useState(null);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);

  const [businessRolesOpen, setBusinessRolesOpen] = useState(false);
  const [businessRoles, setBusinessRoles] = useState(null);
  const [businessRolesLoading, setBusinessRolesLoading] = useState(false);

  const [parentResourcesOpen, setParentResourcesOpen] = useState(false);
  const [parentResources, setParentResources] = useState(null);
  const [parentResourcesLoading, setParentResourcesLoading] = useState(false);

  // Lazy-loaded history
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState(cachedData?.history || null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Fetch core data
  useEffect(() => {
    if (cachedData?.core) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Try new endpoint first, fall back to legacy group endpoint
    authFetch(`/api/resources/${encodeURIComponent(resourceId)}`)
      .then(r => {
        if (!r.ok) return authFetch(`/api/group/${encodeURIComponent(resourceId)}`).then(r2 => {
          if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
          return r2.json();
        });
        return r.json();
      })
      .then(d => {
        if (!cancelled) {
          setData(d);
          onCacheData?.(resourceId, 'resource', { core: d });
        }
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [resourceId, authFetch, cachedData?.core, onCacheData]);

  // Lazy-load history
  const loadHistory = useCallback(() => {
    if (history) return;
    setHistoryLoading(true);
    authFetch(`/api/resources/${encodeURIComponent(resourceId)}/history`)
      .then(r => {
        if (!r.ok) return authFetch(`/api/group/${encodeURIComponent(resourceId)}/history`).then(r2 => {
          if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
          return r2.json();
        });
        return r.json();
      })
      .then(d => {
        setHistory(d);
        onCacheData?.(resourceId, 'resource', { history: d });
      })
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [resourceId, authFetch, history, onCacheData]);

  const loadAssignments = useCallback(() => {
    if (assignments) return;
    setAssignmentsLoading(true);
    authFetch(`/api/resources/${encodeURIComponent(resourceId)}/assignments`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setAssignments(d))
      .catch(() => setAssignments([]))
      .finally(() => setAssignmentsLoading(false));
  }, [resourceId, authFetch, assignments]);

  const loadBusinessRoles = useCallback(() => {
    if (businessRoles) return;
    setBusinessRolesLoading(true);
    authFetch(`/api/resources/${encodeURIComponent(resourceId)}/business-roles`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setBusinessRoles(d))
      .catch(() => setBusinessRoles([]))
      .finally(() => setBusinessRolesLoading(false));
  }, [resourceId, authFetch, businessRoles]);

  const loadParentResources = useCallback(() => {
    if (parentResources) return;
    setParentResourcesLoading(true);
    authFetch(`/api/resources/${encodeURIComponent(resourceId)}/parent-resources`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setParentResources(d))
      .catch(() => setParentResources([]))
      .finally(() => setParentResourcesLoading(false));
  }, [resourceId, authFetch, parentResources]);

  const toggleHistory = useCallback(() => {
    setHistoryOpen(prev => {
      if (!prev) loadHistory();
      return !prev;
    });
  }, [loadHistory]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading resource details...</div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h2 className="text-red-800 font-semibold">Error loading resource</h2>
        <p className="text-red-600 mt-1 text-sm">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const { attributes, tags, hasHistory } = data;
  const resourceType = attributes.resourceType || attributes.groupTypeCalculated || '';
  const typeBadgeClass = RESOURCE_TYPE_COLORS[resourceType] || 'bg-gray-100 text-gray-700';
  const extAttrs = parseExtendedAttributes(attributes.extendedAttributes);
  const historyCount = history ? history.length : (hasHistory ? null : 1);
  const otherAttributes = [['id', attributes.id], ...Object.entries(attributes).filter(([k]) => !HIDDEN_FIELDS.has(k) && k !== 'id')];

  // Build Entra URL if this is an Entra group
  const isEntraGroup = resourceType === 'EntraGroup' || attributes.groupTypeCalculated;
  const entraUrl = isEntraGroup
    ? `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/${encodeURIComponent(resourceId)}`
    : null;

  const historyDiffs = history ? computeHistoryDiffs(history) : [];

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-lg font-bold">
              R
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{attributes.displayName}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                {resourceType && (
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${typeBadgeClass}`}>
                    {resourceType}
                  </span>
                )}
                {attributes.systemId && (
                  <span className="text-xs text-gray-400">
                    System: {attributes.systemId}
                  </span>
                )}
              </div>
            </div>
          </div>
          {attributes.description && (
            <p className="text-sm text-gray-600 mt-2 max-w-2xl">{attributes.description}</p>
          )}
          {tags && tags.length > 0 && (
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
      <RiskScoreSection attributes={attributes} entityType="group" entityId={resourceId} authFetch={authFetch} />

      {/* Attributes */}
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

      {/* Extended Attributes (parsed from JSON) */}
      {extAttrs && Object.keys(extAttrs).length > 0 && (
        <div className="mt-6">
          <Section title="Extended Attributes" count={Object.keys(extAttrs).filter(k => extAttrs[k] != null).length}>
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(extAttrs)
                  .filter(([, val]) => val != null)
                  .map(([key, val]) => (
                    <tr key={key} className="border-b border-gray-50 last:border-b-0">
                      <td className="py-1 pr-4 text-gray-500 whitespace-nowrap align-top">{friendlyLabel(key)}</td>
                      <td className="py-1 text-gray-900 font-medium break-all">
                        {typeof val === 'object' ? JSON.stringify(val) : formatValue(val)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Section>
        </div>
      )}

      {/* Assigned Users */}
      <div className="mt-6">
        <CollapsibleSection
          title="Assigned Users"
          count={assignments ? assignments.length : null}
          open={assignmentsOpen}
          onToggle={() => { if (!assignmentsOpen) loadAssignments(); setAssignmentsOpen(p => !p); }}
          loading={assignmentsLoading}
        >
          {assignments && assignments.length === 0 ? (
            <p className="text-sm text-gray-400 italic p-4">No assignments</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 font-medium">User</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Assignment</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {(assignments || []).map((a, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => onOpenDetail?.('user', a.principalId, a.principalDisplayName)}
                        className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                      >{a.principalDisplayName || a.principalId}</button>
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{a.principalType}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${ASSIGNMENT_TYPE_COLORS[a.assignmentType] || 'bg-gray-100 text-gray-700'}`}>
                        {a.assignmentType}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{a.assignmentStatus || a.state || '\u2014'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>
      </div>

      {/* Business Roles containing this resource */}
      <div className="mt-6">
        <CollapsibleSection
          title="Business Roles"
          count={businessRoles ? businessRoles.length : null}
          open={businessRolesOpen}
          onToggle={() => { if (!businessRolesOpen) loadBusinessRoles(); setBusinessRolesOpen(p => !p); }}
          loading={businessRolesLoading}
        >
          {businessRoles && businessRoles.length === 0 ? (
            <p className="text-sm text-gray-400 italic p-4">Not part of any business role</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 font-medium">Business Role</th>
                  <th className="px-4 py-2 font-medium">Role Name</th>
                </tr>
              </thead>
              <tbody>
                {(businessRoles || []).map((br, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => onOpenDetail?.('resource', br.businessRoleId, br.businessRoleName)}
                        className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                      >{br.businessRoleName}</button>
                    </td>
                    <td className="px-4 py-2 text-gray-500">{br.roleName || '\u2014'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>
      </div>

      {/* Parent Resources (resources this resource is a member of) */}
      <div className="mt-6">
        <CollapsibleSection
          title="Member Of"
          count={parentResources ? parentResources.length : null}
          open={parentResourcesOpen}
          onToggle={() => { if (!parentResourcesOpen) loadParentResources(); setParentResourcesOpen(p => !p); }}
          loading={parentResourcesLoading}
        >
          {parentResources && parentResources.length === 0 ? (
            <p className="text-sm text-gray-400 italic p-4">Not a member of any other resource</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 font-medium">Parent Resource</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Relationship</th>
                </tr>
              </thead>
              <tbody>
                {(parentResources || []).map((pr, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => onOpenDetail?.('resource', pr.parentResourceId, pr.parentDisplayName)}
                        className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                      >{pr.parentDisplayName || pr.parentResourceId}</button>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${RESOURCE_TYPE_COLORS[pr.parentResourceType] || 'bg-gray-100 text-gray-700'}`}>
                        {pr.parentResourceType}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{pr.relationshipType}{pr.roleName ? ` (${pr.roleName})` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>
      </div>

      {/* Version History */}
      <div className="mt-6">
        <CollapsibleSection
          title="Version History"
          count={historyCount}
          countLabel={historyCount === 1 ? 'version' : 'versions'}
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

function Section({ title, count, children }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
        {title}
        {count != null && <span className="text-xs font-normal text-gray-400">({count})</span>}
      </h3>
      {children}
    </div>
  );
}

function CollapsibleSection({ title, count, countLabel, open, onToggle, loading, children }) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 text-sm font-semibold text-gray-700 mb-2 hover:text-gray-900"
      >
        <span className="text-xs">{open ? '\u25BC' : '\u25B6'}</span>
        {title}
        {count != null && (
          <span className="text-xs font-normal text-gray-400">
            ({count}{countLabel ? ` ${countLabel}` : ''})
          </span>
        )}
        {loading && <span className="text-xs text-gray-400 animate-pulse">Loading...</span>}
      </button>
      {open && !loading && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {children}
        </div>
      )}
    </div>
  );
}

