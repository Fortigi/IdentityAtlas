import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import RiskScoreSection from './RiskScoreSection';
import { formatDate, formatValue, computeHistoryDiffs, friendlyLabel } from '../utils/formatters';
import { Section, CollapsibleSection } from './DetailSection';

const HEADER_FIELDS = ['catalogName', 'catalogId', 'description'];
const HIDDEN_FIELDS = new Set(['displayName', ...HEADER_FIELDS, 'ValidFrom', 'ValidTo']);

const SCOPE_LABELS = {
  allMemberUsers:                          'All member users',
  allDirectoryUsers:                       'All directory users',
  specificDirectoryUsers:                  'Specific directory users',
  allDirectoryServicePrincipals:           'All service principals',
  specificDirectoryServicePrincipals:      'Specific service principals',
  specificConnectedOrganizationUsers:      'Specific connected org users',
  allConfiguredConnectedOrganizationUsers: 'All configured connected org users',
  allExternalUsers:                        'All external users',
  notSpecified:                            'Not specified',
};

function formatScope(val) {
  if (!val) return '\u2014';
  return SCOPE_LABELS[val] || val;
}

const DECISION_STYLES = {
  Approve: 'bg-green-100 text-green-800',
  Deny: 'bg-red-100 text-red-800',
  DontKnow: 'bg-yellow-100 text-yellow-800',
  NotReviewed: 'bg-gray-100 text-gray-600',
};

const DECISION_LABELS = {
  Approve: 'Approved',
  Deny: 'Denied',
  DontKnow: 'Don\u2019t Know',
  NotReviewed: 'Not Reviewed',
};

const REQUEST_STATE_STYLES = {
  PendingApproval: 'bg-yellow-100 text-yellow-800',
  Delivering: 'bg-blue-100 text-blue-800',
  Accepted: 'bg-green-100 text-green-800',
};

const ASSIGNMENT_TYPE_STYLES = {
  'Auto-assigned': 'bg-green-100 text-green-800 border-green-200',
  'Request-based': 'bg-blue-100 text-blue-800 border-blue-200',
  'Request-based with auto-removal': 'bg-orange-100 text-orange-800 border-orange-200',
  'Both': 'bg-purple-100 text-purple-800 border-purple-200',
};

export default function AccessPackageDetailPage({ accessPackageId, cachedData, onCacheData, onClose }) {
  const { authFetch } = useAuth();

  // Core data (fast - attributes, counts)
  const [data, setData] = useState(cachedData?.core || null);
  const [loading, setLoading] = useState(!cachedData?.core);
  const [error, setError] = useState(null);

  // Lazy-loaded sections
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const [reviews, setReviews] = useState(cachedData?.reviews || null);
  const [reviewsLoading, setReviewsLoading] = useState(false);

  const [requestsOpen, setRequestsOpen] = useState(false);
  const [requests, setRequests] = useState(cachedData?.requests || null);
  const [requestsLoading, setRequestsLoading] = useState(false);

  const [assignmentsOpen, setAssignmentsOpen] = useState(false);
  const [assignments, setAssignments] = useState(cachedData?.assignments || null);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);

  const [resourceRolesOpen, setResourceRolesOpen] = useState(false);
  const [resourceRoles, setResourceRoles] = useState(cachedData?.resourceRoles || null);
  const [resourceRolesLoading, setResourceRolesLoading] = useState(false);

  const [policiesOpen, setPoliciesOpen] = useState(false);
  const [policies, setPolicies] = useState(cachedData?.policies || null);
  const [policiesLoading, setPoliciesLoading] = useState(false);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState(cachedData?.history || null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [riskData, setRiskData] = useState(null);

  // Fetch risk score data
  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/risk-scores/business-roles/${accessPackageId}`);
        if (res.ok) setRiskData(await res.json());
      } catch { /* risk data optional */ }
    })();
  }, [authFetch, accessPackageId]);

  // Fetch core data
  useEffect(() => {
    if (cachedData?.core) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(`/api/access-package/${encodeURIComponent(accessPackageId)}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        if (!cancelled) {
          setData(d);
          onCacheData?.(accessPackageId, 'access-package', { core: d });
        }
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accessPackageId, authFetch, cachedData?.core, onCacheData]);

  // Lazy-load reviews
  const loadReviews = useCallback(() => {
    if (reviews) return;
    setReviewsLoading(true);
    authFetch(`/api/access-package/${encodeURIComponent(accessPackageId)}/reviews`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setReviews(d);
        onCacheData?.(accessPackageId, 'access-package', { reviews: d });
      })
      .catch(() => setReviews([]))
      .finally(() => setReviewsLoading(false));
  }, [accessPackageId, authFetch, reviews, onCacheData]);

  // Lazy-load requests
  const loadRequests = useCallback(() => {
    if (requests) return;
    setRequestsLoading(true);
    authFetch(`/api/access-package/${encodeURIComponent(accessPackageId)}/requests`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setRequests(d);
        onCacheData?.(accessPackageId, 'access-package', { requests: d });
      })
      .catch(() => setRequests([]))
      .finally(() => setRequestsLoading(false));
  }, [accessPackageId, authFetch, requests, onCacheData]);

  // Lazy-load assignments
  const loadAssignments = useCallback(() => {
    if (assignments) return;
    setAssignmentsLoading(true);
    authFetch(`/api/access-package/${encodeURIComponent(accessPackageId)}/assignments`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setAssignments(d);
        onCacheData?.(accessPackageId, 'access-package', { assignments: d });
      })
      .catch(() => setAssignments([]))
      .finally(() => setAssignmentsLoading(false));
  }, [accessPackageId, authFetch, assignments, onCacheData]);

  // Lazy-load resource roles
  const loadResourceRoles = useCallback(() => {
    if (resourceRoles) return;
    setResourceRolesLoading(true);
    authFetch(`/api/access-package/${encodeURIComponent(accessPackageId)}/resource-roles`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setResourceRoles(d);
        onCacheData?.(accessPackageId, 'access-package', { resourceRoles: d });
      })
      .catch(() => setResourceRoles([]))
      .finally(() => setResourceRolesLoading(false));
  }, [accessPackageId, authFetch, resourceRoles, onCacheData]);

  // Lazy-load policies
  const loadPolicies = useCallback(() => {
    if (policies) return;
    setPoliciesLoading(true);
    authFetch(`/api/access-package/${encodeURIComponent(accessPackageId)}/policies`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setPolicies(d);
        onCacheData?.(accessPackageId, 'access-package', { policies: d });
      })
      .catch(() => setPolicies([]))
      .finally(() => setPoliciesLoading(false));
  }, [accessPackageId, authFetch, policies, onCacheData]);

  // Lazy-load history
  const loadHistory = useCallback(() => {
    if (history) return;
    setHistoryLoading(true);
    authFetch(`/api/access-package/${encodeURIComponent(accessPackageId)}/history`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setHistory(d);
        onCacheData?.(accessPackageId, 'access-package', { history: d });
      })
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [accessPackageId, authFetch, history, onCacheData]);

  const toggleReviews = useCallback(() => {
    setReviewsOpen(prev => { if (!prev) loadReviews(); return !prev; });
  }, [loadReviews]);

  const toggleRequests = useCallback(() => {
    setRequestsOpen(prev => { if (!prev) loadRequests(); return !prev; });
  }, [loadRequests]);

  const toggleAssignments = useCallback(() => {
    setAssignmentsOpen(prev => { if (!prev) loadAssignments(); return !prev; });
  }, [loadAssignments]);

  const toggleResourceRoles = useCallback(() => {
    setResourceRolesOpen(prev => { if (!prev) loadResourceRoles(); return !prev; });
  }, [loadResourceRoles]);

  const togglePolicies = useCallback(() => {
    setPoliciesOpen(prev => { if (!prev) loadPolicies(); return !prev; });
  }, [loadPolicies]);

  const toggleHistory = useCallback(() => {
    setHistoryOpen(prev => { if (!prev) loadHistory(); return !prev; });
  }, [loadHistory]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading business role details...</div>;
  }
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h2 className="text-red-800 font-semibold">Error loading business role</h2>
        <p className="text-red-600 mt-1 text-sm">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const { attributes, assignmentCount, groupCount, reviewCount, pendingRequestCount, lastReviewDate, lastReviewedBy, hasHistory, policyCount, assignmentType, category } = data;
  const catalogName = attributes.catalogName || null;
  const catalogId = attributes.catalogId || null;
  const apDisplayName = attributes.displayName || '';
  const historyCount = history ? history.length : (hasHistory ? null : 1);
  const otherAttributes = [['id', attributes.id], ...Object.entries(attributes).filter(([k]) => !HIDDEN_FIELDS.has(k) && k !== 'id')];
  const entraUrl = catalogId
    ? `https://portal.azure.com/#view/Microsoft_Azure_ELMAdmin/EntitlementMenuBlade/~/overview/entitlementId/${accessPackageId.toLowerCase()}/catalogId/${catalogId}/catalogName/${encodeURIComponent(catalogName || '')}/entitlementName/${encodeURIComponent(apDisplayName)}`
    : `https://entra.microsoft.com/#view/Microsoft_AAD_ERM/AccessPackageManagementMenuBlade/~/AccessPackageBladeOverview/accessPackageId/${encodeURIComponent(accessPackageId)}`;

  const historyDiffs = history ? computeHistoryDiffs(history) : [];

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-lg font-bold">
              AP
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold text-gray-900">{attributes.displayName}</h2>
                {assignmentType && (
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${ASSIGNMENT_TYPE_STYLES[assignmentType] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                    {assignmentType}
                  </span>
                )}
                {category && (
                  <span
                    className="inline-block px-2 py-0.5 rounded-full text-xs font-medium border"
                    style={{ backgroundColor: category.color + '20', borderColor: category.color, color: category.color }}
                  >
                    {category.name}
                  </span>
                )}
              </div>
              {catalogName && (
                <p className="text-sm text-gray-500">Catalog: {catalogName}</p>
              )}
            </div>
          </div>
          {attributes.description && (
            <p className="text-sm text-gray-600 mt-2 max-w-2xl">{attributes.description}</p>
          )}
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-600">
            {assignmentCount > 0 && <span>{assignmentCount} assignment{assignmentCount !== 1 ? 's' : ''}</span>}
            {groupCount > 0 && (
              <>
                {assignmentCount > 0 && <span className="text-gray-400">|</span>}
                <span>{groupCount} group{groupCount !== 1 ? 's' : ''}</span>
              </>
            )}
            {reviewCount > 0 && (
              <>
                {(assignmentCount > 0 || groupCount > 0) && <span className="text-gray-400">|</span>}
                <span>{reviewCount} review{reviewCount !== 1 ? 's' : ''}</span>
              </>
            )}
            {requests && requests.length > 0 && (
              <>
                <span className="text-gray-400">|</span>
                <span className="text-yellow-700 font-medium">{requests.length} pending request{requests.length !== 1 ? 's' : ''}</span>
              </>
            )}
          </div>
          {lastReviewDate && (
            <div className="mt-2 text-sm text-gray-600">
              <span className="text-gray-500">Last Certification:</span>{' '}
              <span className="font-medium">{formatDate(lastReviewDate)}</span>
              {lastReviewedBy && <span className="text-gray-500"> by {lastReviewedBy}</span>}
            </div>
          )}
          <a href={entraUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-2 text-xs text-blue-600 hover:text-blue-800 hover:underline">
            Open in Entra ID
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
        <button onClick={onClose}
          className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
          title="Close tab">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Risk Score */}
      {riskData && <RiskScoreSection attributes={riskData} entityType="business-roles" entityId={accessPackageId} authFetch={authFetch} />}

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

      {/* Assignments (users assigned to this AP) */}
      {assignmentCount > 0 && (
        <div className="mt-6">
          <CollapsibleSection
            title="Assignments"
            count={assignmentCount}
            open={assignmentsOpen}
            onToggle={toggleAssignments}
            loading={assignmentsLoading}
          >
            {assignments && assignments.length === 0 ? (
              <p className="text-sm text-gray-400 italic p-4">No assignments found</p>
            ) : assignments && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-2 font-medium">User</th>
                    <th className="px-4 py-2 font-medium">State</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Assigned</th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map(a => (
                    <tr key={a.id} className="border-b border-gray-50">
                      <td className="px-4 py-2">
                        <div className="text-gray-900 font-medium">{a.targetDisplayName || '\u2014'}</div>
                        {a.targetUPN && <div className="text-xs text-gray-400">{a.targetUPN}</div>}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          a.assignmentState === 'Delivered' ? 'bg-green-100 text-green-800'
                          : a.assignmentState === 'Delivering' ? 'bg-blue-100 text-blue-800'
                          : a.assignmentState === 'Expired' ? 'bg-gray-100 text-gray-600'
                          : 'bg-yellow-100 text-yellow-800'
                        }`}>
                          {a.assignmentState || '\u2014'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-500 text-xs">{a.assignmentStatus || '\u2014'}</td>
                      <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">{formatDate(a.assignedDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CollapsibleSection>
        </div>
      )}

      {/* Resource Assignments (groups/resources in this AP) */}
      {groupCount > 0 && (
        <div className="mt-4">
          <CollapsibleSection
            title="Resource Assignments"
            count={groupCount}
            open={resourceRolesOpen}
            onToggle={toggleResourceRoles}
            loading={resourceRolesLoading}
          >
            {resourceRoles && resourceRoles.length === 0 ? (
              <p className="text-sm text-gray-400 italic p-4">No resource assignments found</p>
            ) : resourceRoles && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-2 font-medium">Resource</th>
                    <th className="px-4 py-2 font-medium">Role</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Added</th>
                  </tr>
                </thead>
                <tbody>
                  {resourceRoles.map(rr => (
                    <tr key={rr.id} className="border-b border-gray-50">
                      <td className="px-4 py-2">
                        <div className="text-gray-900 font-medium">{rr.groupDisplayName || rr.scopeDisplayName || '\u2014'}</div>
                        {rr.scopeOriginSystem && <div className="text-xs text-gray-400">{rr.scopeOriginSystem}</div>}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          rr.roleDisplayName === 'Owner' ? 'bg-purple-100 text-purple-800'
                          : rr.roleDisplayName === 'Member' ? 'bg-blue-100 text-blue-800'
                          : 'bg-gray-100 text-gray-600'
                        }`}>
                          {rr.roleDisplayName || '\u2014'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-500 text-xs">{rr.roleOriginSystem || '\u2014'}</td>
                      <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">{formatDate(rr.createdDateTime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CollapsibleSection>
        </div>
      )}

      {/* Assignment Policies */}
      {policyCount > 0 && (
        <div className="mt-6">
          <CollapsibleSection
            title="Assignment Policies"
            count={policyCount}
            open={policiesOpen}
            onToggle={togglePolicies}
            loading={policiesLoading}
          >
            {policies && policies.length === 0 ? (
              <p className="text-sm text-gray-400 italic p-4">No policies found</p>
            ) : policies && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Scope</th>
                    <th className="px-4 py-2 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map(p => (
                    <tr key={p.id} className="border-b border-gray-50">
                      <td className="px-4 py-2">
                        <div className="text-gray-900 font-medium">{p.displayName || '\u2014'}</div>
                        {p.description && <div className="text-xs text-gray-400 mt-0.5 truncate max-w-xs" title={p.description}>{p.description}</div>}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          p.hasAutoAddRule ? 'bg-green-100 text-green-800'
                          : p.hasAutoRemoveRule ? 'bg-orange-100 text-orange-800'
                          : 'bg-blue-100 text-blue-800'
                        }`}>
                          {p.hasAutoAddRule ? 'Auto-assigned'
                           : p.hasAutoRemoveRule ? 'Request-based with auto-removal'
                           : 'Request-based'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-600 text-xs">
                        <div>{formatScope(p.allowedTargetScope)}</div>
                        {p.autoAssignmentFilter && (
                          <div className="mt-0.5 text-gray-400 font-mono text-[11px] leading-snug break-all" title="Auto-assignment filter rule">
                            {p.autoAssignmentFilter}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">
                        {formatDate(p.createdDateTime)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CollapsibleSection>
        </div>
      )}

      {/* Access Reviews */}
      <div className="mt-6">
        <CollapsibleSection
          title="Certification Decisions"
          count={reviewCount}
          open={reviewsOpen}
          onToggle={toggleReviews}
          loading={reviewsLoading}
        >
          {reviews && reviews.length === 0 ? (
            <p className="text-sm text-gray-400 italic p-4">No certification decisions found yet</p>
          ) : reviews && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 font-medium">User</th>
                  <th className="px-4 py-2 font-medium">Reviewed By</th>
                  <th className="px-4 py-2 font-medium">Decision</th>
                  <th className="px-4 py-2 font-medium">Recommendation</th>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map(r => (
                  <tr key={r.id} className="border-b border-gray-50">
                    <td className="px-4 py-2 text-gray-900">{r.principalDisplayName || '\u2014'}</td>
                    <td className="px-4 py-2 text-gray-600">{r.reviewedByDisplayName || '\u2014'}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${DECISION_STYLES[r.decision] || 'bg-gray-100 text-gray-600'}`}>
                        {DECISION_LABELS[r.decision] || r.decision || '\u2014'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{r.recommendation || '\u2014'}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">{formatDate(r.reviewedDateTime)}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{r.reviewInstanceStatus || '\u2014'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>
      </div>

      {/* Pending Requests */}
      <div className="mt-4">
        <CollapsibleSection
          title="Pending Requests"
          count={requests ? requests.length : null}
          open={requestsOpen}
          onToggle={toggleRequests}
          loading={requestsLoading}
        >
          {requests && requests.length === 0 ? (
            <p className="text-sm text-gray-400 italic p-4">No pending requests</p>
          ) : requests && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 font-medium">Requestor</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">State</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                  <th className="px-4 py-2 font-medium">Justification</th>
                </tr>
              </thead>
              <tbody>
                {requests.map(r => (
                  <tr key={r.id} className="border-b border-gray-50">
                    <td className="px-4 py-2 text-gray-900">
                      <div>{r.requestorDisplayName || '\u2014'}</div>
                      {r.requestorUPN && <div className="text-xs text-gray-400">{r.requestorUPN}</div>}
                    </td>
                    <td className="px-4 py-2 text-gray-600 text-xs">{r.requestType || '\u2014'}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${REQUEST_STATE_STYLES[r.requestState] || 'bg-gray-100 text-gray-600'}`}>
                        {r.requestState || '\u2014'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{r.requestStatus || '\u2014'}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">{formatDate(r.createdDateTime)}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs truncate max-w-xs" title={r.justification || ''}>
                      {r.justification || '\u2014'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>
      </div>

      {/* Version History */}
      <div className="mt-4">
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


