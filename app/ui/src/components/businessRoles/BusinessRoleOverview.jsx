import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { formatDate } from '@ui/utils/formatters';
import { COMPLIANCE_STYLES } from '@ui/utils/accessPackageStyles';
import BusinessRoleOwners from './BusinessRoleOwners';
import WayChips from './WayChips';
import { approvalText, describeCadence, describeExpiry, removalText, ruleLabel } from './accessModel';

// ─── Overview of a business role ─────────────────────────────────────────
// Who answers for it, then how people get it and lose it. What a policy shows
// follows from what that policy does: a rule shows the rule and how many people
// hold the role through it, a requestable policy its approval, a removal rule
// its condition, and so on.

function Card({ title, children }) {
  return (
    <section className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <h3 className="border-b border-gray-200 bg-gray-50 px-4 py-2.5 text-sm font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-200">{title}</h3>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function Stat({ label, value, onClick }) {
  const body = (
    <>
      <span className="block text-lg font-semibold text-gray-900 dark:text-gray-100">{value}</span>
      <span className="block text-xs text-gray-600 dark:text-gray-400">{label}</span>
    </>
  );
  if (!onClick) return <div className="rounded border border-gray-200 px-3 py-2 dark:border-gray-700">{body}</div>;
  return (
    <button type="button" onClick={onClick} className="rounded border border-gray-200 px-3 py-2 text-left hover:border-blue-400 hover:bg-blue-50 dark:border-gray-700 dark:hover:border-blue-500 dark:hover:bg-blue-900/20">
      {body}
    </button>
  );
}

const policyWaysIn = (p) => [p.hasAutoAddRule && 'Rule', p.allowsRequest && 'Request', p.allowsDirectAssignment && 'Assigned'].filter(Boolean);
const policyWaysOut = (p) => [p.hasAutoRemoveRule && 'Rule', p.hasAccessReview && 'Review', p.hasExpiration && 'Expiry', p.allowsRemovalRequest && 'Manual'].filter(Boolean);

function PolicyCard({ policy }) {
  const facts = [
    approvalText(policy),
    removalText(policy),
    describeExpiry(policy.expiration, formatDate),
    policy.hasAccessReview ? describeCadence(policy.reviewSettings) : null,
  ].filter(Boolean);
  const waysIn = policyWaysIn(policy);
  return (
    <li className="py-3 first:pt-0 last:pb-0" data-testid="role-policy">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{policy.displayName || 'Policy'}</span>
        <span className="text-xs text-gray-600 dark:text-gray-400">
          {policy.holderCount ?? 0} {policy.holderCount === 1 ? 'person holds' : 'people hold'} the role through this policy
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
        <span className="inline-flex items-center gap-1">In: <WayChips ways={waysIn.length ? waysIn : ['Unknown']} direction="in" /></span>
        <span className="inline-flex items-center gap-1">Out: <WayChips ways={policyWaysOut(policy)} direction="out" none="Nothing removes it" /></span>
      </div>
      {policy.targetRule && (
        <div className="mt-2">
          <div className="text-xs font-medium text-gray-700 dark:text-gray-300">{ruleLabel(policy)}</div>
          <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all rounded bg-gray-50 px-2 py-1 font-mono text-xs text-gray-800 dark:bg-gray-900/50 dark:text-gray-200">{policy.targetRule}</pre>
        </div>
      )}
      {facts.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-gray-700 dark:text-gray-300">
          {facts.map(f => <li key={f}>{f}</li>)}
        </ul>
      )}
    </li>
  );
}

function ReviewStatus({ data }) {
  if (!data.complianceStatus && !data.lastReviewDate) return null;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
      {data.complianceStatus && (
        <span className={`inline-block rounded-full border px-2 py-0.5 font-medium ${COMPLIANCE_STYLES[data.complianceStatus] || ''}`}>
          {data.complianceStatus}{data.daysOverdue ? ` (${data.daysOverdue}d ago)` : ''}
        </span>
      )}
      {data.lastReviewDate && <span>Last reviewed {formatDate(data.lastReviewDate)}{data.lastReviewedBy ? ` by ${data.lastReviewedBy}` : ''}</span>}
    </p>
  );
}

export default function BusinessRoleOverview({ roleId, data, onOpenDetail, onOpenTab }) {
  const { authFetch } = useAuth();
  const { data: policies, loading } = useFetch(`/api/access-package/${encodeURIComponent(roleId)}/policies`, { authFetch, initialData: [] });
  const list = Array.isArray(policies) ? policies : [];
  const { waysIn, waysOut } = data.accessModel ?? {};

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="People" value={data.assignmentCount ?? 0} onClick={() => onOpenTab('members')} />
        <Stat label="Resources" value={data.groupCount ?? 0} onClick={() => onOpenTab('resources')} />
        <Stat label="Pending requests" value={data.pendingRequestCount ?? 0} />
        <Stat label="Review decisions" value={data.reviewCount ?? 0} />
      </div>

      <Card title="Who answers for this role">
        <BusinessRoleOwners roleId={roleId} onOpenDetail={onOpenDetail} />
      </Card>

      <Card title="How people get and lose this role">
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-gray-600 dark:text-gray-400">Gained by</dt>
            <dd className="mt-0.5"><WayChips ways={waysIn} direction="in" /></dd>
          </div>
          <div>
            <dt className="text-xs text-gray-600 dark:text-gray-400">Lost by</dt>
            <dd className="mt-0.5"><WayChips ways={waysOut} direction="out" none="Nothing removes it automatically" /></dd>
          </div>
        </dl>
        <ReviewStatus data={data} />
        <div className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-700">
          {loading && <p className="text-sm text-gray-600 dark:text-gray-400">Loading policies…</p>}
          {!loading && list.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-400">The source delivers no assignment policies for this role.</p>}
          {!loading && list.length > 0 && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {list.map(p => <PolicyCard key={p.id} policy={p} />)}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
