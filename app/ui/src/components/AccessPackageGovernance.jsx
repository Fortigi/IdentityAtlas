import { useState, useEffect } from 'react';
import { formatDate } from '../utils/formatters';

// ─── AccessPackageGovernance ──────────────────────────────────────────
// Surfaces the records that back a Business Role's governance overview
// (the Review Status / Reviewed By / Type shown in the list) as explicit
// references on the detail page: assignment Policies, Access Reviews
// (certification decisions), and pending assignment Requests. These are
// leaf records (no detail page of their own), so they're shown inline.
// Lazy: mounted only when the Relationships tab is open.

function Section({ title, count, children }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{title}</h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">{count}</span>
      </div>
      {children}
    </div>
  );
}

function Empty({ text }) {
  return <p className="px-4 py-3 text-sm text-gray-600 dark:text-gray-500 italic">{text}</p>;
}

function policyType(p) {
  if (p.hasAutoAddRule && p.hasAutoRemoveRule) return 'Auto add + remove';
  if (p.hasAutoAddRule) return 'Auto-assigned';
  if (p.hasAutoRemoveRule) return 'Auto-remove';
  return 'Request-based';
}

const DECISION_STYLE = {
  Approve: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  Deny: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  DontKnow: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  NotReviewed: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
};

export default function AccessPackageGovernance({ accessPackageId, authFetch }) {
  const [data, setData] = useState({ policies: null, reviews: null, requests: null });

  useEffect(() => {
    let cancelled = false;
    const get = (p) => authFetch(`/api/access-package/${encodeURIComponent(accessPackageId)}/${p}`)
      .then(r => (r.ok ? r.json() : []))
      .catch(() => []);
    Promise.all([get('policies'), get('reviews'), get('requests')]).then(([policies, reviews, requests]) => {
      if (!cancelled) setData({ policies, reviews, requests });
    });
    return () => { cancelled = true; };
  }, [accessPackageId, authFetch]);

  const { policies, reviews, requests } = data;

  return (
    <div className="space-y-4">
      {/* Policies */}
      <Section title="Assignment Policies" count={policies?.length ?? '…'}>
        {!policies ? <Empty text="Loading…" />
          : policies.length === 0 ? <Empty text="No assignment policies." />
          : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {policies.map(p => (
                <li key={p.id} className="px-4 py-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.displayName || 'Policy'}</span>
                    <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700">{policyType(p)}</span>
                    {p.allowedTargetScope && <span className="text-xs text-gray-500 dark:text-gray-400">scope: {p.allowedTargetScope}</span>}
                  </div>
                  {p.description && <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{p.description}</p>}
                  {p.autoAssignmentFilter && <p className="text-xs text-gray-500 dark:text-gray-500 mt-0.5 font-mono break-all">rule: {p.autoAssignmentFilter}</p>}
                </li>
              ))}
            </ul>
          )}
      </Section>

      {/* Access Reviews — the records behind "Review Status" / "Reviewed by" */}
      <Section title="Access Reviews" count={reviews?.length ?? '…'}>
        {!reviews ? <Empty text="Loading…" />
          : reviews.length === 0 ? <Empty text="No access reviews recorded." />
          : (
            <div className="max-h-[360px] overflow-y-auto">
              <table className="w-full text-sm">
                <tbody>
                  {reviews.map(r => (
                    <tr key={r.id} className="border-b border-gray-50 dark:border-gray-700/50 last:border-b-0">
                      <td className="px-4 py-2 align-top whitespace-nowrap text-xs text-gray-500 dark:text-gray-400 w-32">{formatDate(r.reviewedDateTime) || '—'}</td>
                      <td className="px-2 py-2 align-top whitespace-nowrap">
                        {r.decision && (
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${DECISION_STYLE[r.decision] || DECISION_STYLE.NotReviewed}`}>{r.decision}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 align-top text-gray-900 dark:text-gray-100">
                        {r.principalDisplayName && <span className="font-medium">{r.principalDisplayName}</span>}
                        {r.reviewedByDisplayName && <span className="text-gray-500 dark:text-gray-400"> · by {r.reviewedByDisplayName}</span>}
                        {r.reviewInstanceStatus && <span className="text-xs text-gray-500 dark:text-gray-500"> · {r.reviewInstanceStatus}</span>}
                        {r.justification && <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{r.justification}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Section>

      {/* Pending Requests */}
      <Section title="Pending Requests" count={requests?.length ?? '…'}>
        {!requests ? <Empty text="Loading…" />
          : requests.length === 0 ? <Empty text="No pending requests." />
          : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {requests.map(req => (
                <li key={req.id} className="px-4 py-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{req.requestorDisplayName || 'Requestor'}</span>
                    {req.requestType && <span className="text-xs text-gray-500 dark:text-gray-400">{req.requestType}</span>}
                    {req.requestState && <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700">{req.requestState}</span>}
                    <span className="text-xs text-gray-500 dark:text-gray-400">{formatDate(req.createdDateTime)}</span>
                  </div>
                  {req.justification && <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{req.justification}</p>}
                </li>
              ))}
            </ul>
          )}
      </Section>
    </div>
  );
}
