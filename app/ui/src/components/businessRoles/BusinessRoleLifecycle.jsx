import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { formatDate } from '@ui/utils/formatters';
import { COMPLIANCE_STYLES } from '@ui/utils/accessPackageStyles';
import BusinessRoleParticipants from './BusinessRoleParticipants';
import WayChips from './WayChips';
import {
  approvalText, controlSummary, describeCadence, describeExpiry, groupParticipants, lifecycleFacts, removalText, ruleLabel,
} from './accessModel';

// ─── The life of a role assignment ───────────────────────────────────────
// Three questions, in the order a person meets them: how do you get this role,
// what keeps it in check while you hold it, and how do you lose it. The policy
// by policy detail stays folded away underneath.

const MUTED = 'text-xs text-gray-600 dark:text-gray-400';

function Stage({ title, children }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Fact({ label, children }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">{label}</div>
      {children}
    </div>
  );
}

function Rules({ label, rules }) {
  if (rules.length === 0) return null;
  return (
    <Fact label={label}>
      {rules.map(rule => (
        <pre key={rule} className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-gray-50 px-2 py-1 font-mono text-xs text-gray-800 dark:bg-gray-900/50 dark:text-gray-200">{rule}</pre>
      ))}
    </Fact>
  );
}

function Lines({ items }) {
  if (items.length === 0) return null;
  return <ul className="space-y-0.5 text-sm text-gray-800 dark:text-gray-200">{items.map(t => <li key={t}>{t}</li>)}</ul>;
}

function People({ label, people, onOpenDetail }) {
  if (people.length === 0) return null;
  return <Fact label={label}><BusinessRoleParticipants people={people} onOpenDetail={onOpenDetail} /></Fact>;
}

function ReviewStatus({ data }) {
  if (!data.complianceStatus && !data.lastReviewDate) return null;
  return (
    <Fact label="Last review">
      <p className="flex flex-wrap items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
        {data.complianceStatus && (
          <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${COMPLIANCE_STYLES[data.complianceStatus] || ''}`}>
            {data.complianceStatus}{data.daysOverdue ? ` (${data.daysOverdue}d ago)` : ''}
          </span>
        )}
        {data.lastReviewDate && <span>{formatDate(data.lastReviewDate)}{data.lastReviewedBy ? ` by ${data.lastReviewedBy}` : ''}</span>}
      </p>
    </Fact>
  );
}

const policyWaysIn = (p) => [p.hasAutoAddRule && 'Rule', p.allowsRequest && 'Request', p.allowsDirectAssignment && 'Assigned'].filter(Boolean);
const policyWaysOut = (p) => [p.hasAutoRemoveRule && 'Rule', p.hasAccessReview && 'Review', p.hasExpiration && 'Expiry', p.allowsRemovalRequest && 'Manual'].filter(Boolean);

function PolicyRow({ policy }) {
  const facts = [
    approvalText(policy),
    removalText(policy),
    describeExpiry(policy.expiration, formatDate),
    policy.hasAccessReview ? describeCadence(policy.reviewSettings) : null,
  ].filter(Boolean);
  const waysIn = policyWaysIn(policy);
  const waysOut = policyWaysOut(policy);
  return (
    <li className="py-3 first:pt-0 last:pb-0" data-testid="role-policy">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{policy.displayName || 'Policy'}</span>
        <span className={MUTED}>{policy.holderCount ?? 0} {policy.holderCount === 1 ? 'person' : 'people'}</span>
      </div>
      <div className={`mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 ${MUTED}`}>
        {waysIn.length > 0 && <span className="inline-flex items-center gap-1">Gained by <WayChips ways={waysIn} direction="in" /></span>}
        {waysOut.length > 0 && <span className="inline-flex items-center gap-1">Lost by <WayChips ways={waysOut} direction="out" /></span>}
      </div>
      {policy.targetRule && <div className="mt-2"><Rules label={ruleLabel(policy)} rules={[policy.targetRule]} /></div>}
      {facts.length > 0 && <ul className="mt-1.5 space-y-0.5 text-xs text-gray-700 dark:text-gray-300">{facts.map(f => <li key={f}>{f}</li>)}</ul>}
    </li>
  );
}

function Policies({ policies }) {
  if (policies.length === 0) {
    return <p className={MUTED}>The source delivers no assignment policies for this role.</p>;
  }
  return (
    <details className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Policies ({policies.length})</summary>
      <ul className="divide-y divide-gray-100 border-t border-gray-100 px-4 py-3 dark:divide-gray-700/50 dark:border-gray-700">
        {policies.map(p => <PolicyRow key={p.id} policy={p} />)}
      </ul>
    </details>
  );
}

export default function BusinessRoleLifecycle({ roleId, data, onOpenDetail }) {
  const { authFetch } = useAuth();
  const base = `/api/access-package/${encodeURIComponent(roleId)}`;
  const policyFetch = useFetch(`${base}/policies`, { authFetch, initialData: [] });
  const peopleFetch = useFetch(`${base}/participants`, { authFetch, initialData: [] });
  const model = data.accessModel;

  if (policyFetch.loading || peopleFetch.loading) return <p className="py-6 text-center text-sm text-gray-600 dark:text-gray-400">Loading lifecycle…</p>;
  if (policyFetch.error || peopleFetch.error) return <p role="alert" className="py-6 text-center text-sm text-red-700 dark:text-red-400">Could not load the lifecycle of this role.</p>;

  const policies = Array.isArray(policyFetch.data) ? policyFetch.data : [];
  const people = groupParticipants(Array.isArray(peopleFetch.data) ? peopleFetch.data : []);
  const facts = lifecycleFacts(policies, formatDate);

  return (
    <div className="space-y-4">
      <div data-testid="role-control">
        <p className="text-sm text-gray-800 dark:text-gray-200">{controlSummary(model, data.assignmentCount, data.automaticHolderCount)}</p>
        {model?.reviewGap && (
          <p role="status" className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            No access review is set up for this role.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Stage title="Getting it">
          <WayChips ways={model?.waysIn} direction="in" />
          <People label="Who can request it" people={people.Requestor} onOpenDetail={onOpenDetail} />
          <People label="Who approves" people={people.Approver} onOpenDetail={onOpenDetail} />
          <Lines items={facts.approvals} />
          <Rules label="Added by this rule" rules={facts.addRules} />
        </Stage>
        <Stage title="Keeping it">
          {facts.cadences.length === 0 && people.Reviewer.length === 0 && <p className={MUTED}>No regular review.</p>}
          <Lines items={facts.cadences} />
          <People label="Who reviews" people={people.Reviewer} onOpenDetail={onOpenDetail} />
          <ReviewStatus data={data} />
        </Stage>
        <Stage title="Losing it">
          <WayChips ways={model?.waysOut} direction="out" none="Nothing removes it automatically" />
          <Lines items={[...facts.expiries, ...facts.removalNotes]} />
          <Rules label="Removed when someone stops matching" rules={facts.removeRules} />
        </Stage>
      </div>

      <Policies policies={policies} />
    </div>
  );
}
