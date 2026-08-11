import { useState, useEffect, useMemo } from 'react';
import { formatDate, formatDateOnly } from '@ui/utils/formatters';

// ─── AccessPackageGovernance ──────────────────────────────────────────
// Surfaces the records behind a Business Role's governance overview, in the
// shape they actually relate (see docs/architecture governance model):
//
//   AssignmentPolicy (states whether/how often an access review runs,
//     via reviewSettings.recurrence)
//        └─ Access review campaign (reviewDefinitionId)
//             └─ Review instance (reviewInstanceId — one scheduled run,
//                  with start/end/status)
//                  └─ Decisions (CertificationDecisions — one per principal)
//
// There are no separate definition/instance tables — that hierarchy is
// denormalised onto CertificationDecisions, so we re-group it here by
// instance rather than listing principals flat. Lazy: mounted only when the
// Relationships tab is open.

function Section({ title, count, children }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-gray-50 dark:bg-gray-900/40 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{title}</h3>
        {count != null && <span className="text-xs text-gray-500 dark:text-gray-400">{count}</span>}
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

// Human-readable review cadence from the policy's reviewSettings (the object
// that states how often an access review should happen).
function describeCadence(rs) {
  if (!rs) return null;
  if (rs.isEnabled === false) return 'Access review: disabled';
  const pat = rs.schedule?.recurrence?.pattern;
  const unit = { absoluteMonthly: 'month', relativeMonthly: 'month', weekly: 'week', daily: 'day', absoluteYearly: 'year' }[pat?.type];
  let cad = 'one-time';
  if (pat?.interval && unit) cad = pat.interval === 1 ? `every ${unit}` : `every ${pat.interval} ${unit}s`;
  const durMatch = /P(\d+)D/.exec(rs.schedule?.expiration?.duration || '');
  const window = durMatch ? `, ${durMatch[1]}-day window` : '';
  return `Access review: recurs ${cad}${window}`;
}

const DECISION_STYLE = {
  Approve: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  Deny: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  DontKnow: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  NotReviewed: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
};

function ReviewInstance({ instance }) {
  const [open, setOpen] = useState(false);
  const reviewed = instance.decisions.filter(d => d.decision && d.decision !== 'NotReviewed').length;
  const range = [instance.start && formatDateOnly(instance.start), instance.end && formatDateOnly(instance.end)].filter(Boolean).join(' – ');
  return (
    <div className="border-b border-gray-100 dark:border-gray-700/50 last:border-b-0">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-gray-500 dark:text-gray-400 text-xs">{open ? '▼' : '▶'}</span>
          <span className="text-sm text-gray-900 dark:text-gray-100">{range || 'Review instance'}</span>
          {instance.status && <span className="text-xs text-gray-500 dark:text-gray-400">{instance.status}</span>}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">{reviewed}/{instance.decisions.length} decided</span>
      </button>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {instance.decisions.map(d => (
                <tr key={d.id} className="border-t border-gray-50 dark:border-gray-700/50">
                  <td className="px-4 py-1.5 align-top text-gray-900 dark:text-gray-100">{d.principalDisplayName || '—'}</td>
                  <td className="px-2 py-1.5 align-top whitespace-nowrap">
                    {d.decision && <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${DECISION_STYLE[d.decision] || DECISION_STYLE.NotReviewed}`}>{d.decision}</span>}
                  </td>
                  <td className="px-4 py-1.5 align-top text-xs text-gray-500 dark:text-gray-400">
                    {d.reviewedByDisplayName ? `by ${d.reviewedByDisplayName}` : ''}{d.reviewedDateTime ? ` · ${formatDateOnly(d.reviewedDateTime)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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

  // Group the flat certification decisions back into their review instances.
  const instances = useMemo(() => {
    const map = new Map();
    for (const d of reviews || []) {
      const key = d.reviewInstanceId || `none:${d.id}`;
      if (!map.has(key)) {
        map.set(key, { id: key, start: d.reviewInstanceStartDateTime, end: d.reviewInstanceEndDateTime, status: d.reviewInstanceStatus, decisions: [] });
      }
      map.get(key).decisions.push(d);
    }
    return [...map.values()].sort((a, b) => new Date(b.end || 0) - new Date(a.end || 0));
  }, [reviews]);

  return (
    <div className="space-y-4">
      {/* Policies — incl. the review cadence that drives the schedule */}
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
                  {p.hasAccessReview && describeCadence(p.reviewSettings) && (
                    <p className="text-xs text-gray-700 dark:text-gray-300 mt-0.5">{describeCadence(p.reviewSettings)}</p>
                  )}
                  {p.description && <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{p.description}</p>}
                  {p.autoAssignmentFilter && <p className="text-xs text-gray-500 dark:text-gray-500 mt-0.5 font-mono break-all">rule: {p.autoAssignmentFilter}</p>}
                </li>
              ))}
            </ul>
          )}
      </Section>

      {/* Access Reviews — grouped by review instance (campaign run) */}
      <Section title="Access Reviews" count={reviews ? `${instances.length} instance${instances.length === 1 ? '' : 's'}` : '…'}>
        {!reviews ? <Empty text="Loading…" />
          : instances.length === 0 ? <Empty text="No access reviews recorded." />
          : <div className="max-h-[420px] overflow-y-auto">{instances.map(inst => <ReviewInstance key={inst.id} instance={inst} />)}</div>}
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
