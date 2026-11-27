import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { formatDate, formatDateOnly, formatUtcDay } from '@ui/utils/formatters';
import { stepLabel } from '@ui/components/businessRoles/review/reviewSteps';
import { CAMPAIGN_STATUS, STATUS_INFO, progressText, repeatText, splitRequests } from './campaigns';

// ─── One review campaign ─────────────────────────────────────────────────
// What it asks and when, and how every role of its newest round stands. The
// roles nobody is Accountable for are listed apart, first: they are in scope but
// outside the campaign, because there is nobody to ask.

const CARD = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800';
const MUTED = 'text-xs text-gray-600 dark:text-gray-400';
const TONE = {
  green: 'border-green-200 bg-green-100 text-green-800 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300',
  amber: 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200',
  red: 'border-red-200 bg-red-100 text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300',
  gray: 'border-gray-200 bg-gray-100 text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200',
};

export function StatusBadge({ status }) {
  const info = STATUS_INFO[status] ?? { label: status, tone: 'gray' };
  return <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[info.tone]}`}>{info.label}</span>;
}

function Fact({ label, children }) {
  return (
    <div>
      <dt className={MUTED}>{label}</dt>
      <dd className="text-sm text-gray-900 dark:text-gray-100">{children}</dd>
    </div>
  );
}

function Facts({ campaign }) {
  const { round, scope } = campaign;
  const names = [...scope.portfolios.map(p => `${p.displayName} (portfolio)`), ...scope.roles.map(r => r.displayName)];
  return (
    <dl className={`${CARD} grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4`}>
      <Fact label="Status">{CAMPAIGN_STATUS[campaign.status]}</Fact>
      <Fact label="Reviews">{campaign.steps.map(stepLabel).join(' · ')}</Fact>
      <Fact label="Asked of">The Accountable of each role</Fact>
      <Fact label="How often">{repeatText(campaign.intervalMonths)}, {campaign.dueDays} days per round</Fact>
      <Fact label={round ? `Round ${round.number}` : 'First round'}>
        {round ? `${formatUtcDay(round.startsAt)} – due ${formatUtcDay(round.dueAt)}` : `starts ${formatUtcDay(campaign.startsOn)}`}
      </Fact>
      <Fact label="Progress">{progressText(round)}</Fact>
      <Fact label="Next round">{campaign.nextRoundOn && round ? formatUtcDay(campaign.nextRoundOn) : '—'}</Fact>
      <Fact label="Scope">{names.length ? names.join(', ') : 'Nothing: the roles it was about are gone'}</Fact>
    </dl>
  );
}

function Outside({ requests }) {
  if (requests.length === 0) return null;
  return (
    <section aria-label="Outside the campaign" className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-700 dark:bg-red-900/20">
      <h4 className="text-sm font-semibold text-red-900 dark:text-red-200">
        Outside the campaign: {requests.length} {requests.length === 1 ? 'role has' : 'roles have'} nobody Accountable
      </h4>
      <p className="mt-1 text-sm text-red-900 dark:text-red-200">
        Nobody is asked to review {requests.length === 1 ? 'this role' : 'these roles'}. Set an Accountable on the role and the request goes to them.
      </p>
      <ul className="mt-2 list-disc pl-5 text-sm text-red-950 dark:text-red-100">
        {requests.map(r => <li key={r.id}>{r.roleName}{r.portfolioName ? <span className="text-xs"> · {r.portfolioName}</span> : null}</li>)}
      </ul>
    </section>
  );
}

function Requests({ requests }) {
  if (requests.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <table className="w-full text-sm" aria-label="Roles asked">
        <thead className="bg-gray-50 text-left text-xs text-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">Business role</th>
            <th scope="col" className="px-4 py-2 font-medium">Role portfolio</th>
            <th scope="col" className="px-4 py-2 font-medium">Asked</th>
            <th scope="col" className="px-4 py-2 font-medium">Status</th>
            <th scope="col" className="px-4 py-2 font-medium">Reviewed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
          {requests.map(r => (
            <tr key={r.id}>
              <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{r.roleName}{r.roleDeleted && <span className={`${MUTED} ml-1`}>(deleted in source)</span>}</td>
              <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{r.portfolioName || '—'}</td>
              <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{r.accountable || '—'}</td>
              <td className="px-4 py-2"><StatusBadge status={r.status} /></td>
              <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-300">{r.reviewedAt ? `${r.reviewedByName || r.reviewedBy} · ${formatDate(r.reviewedAt)}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A button that asks once more before it acts.
function ConfirmButton({ label, confirmLabel, onConfirm, busy, danger = false }) {
  const [asking, setAsking] = useState(false);
  const tone = danger
    ? 'border-red-300 text-red-800 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/20'
    : 'border-gray-300 text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700/50';
  if (!asking) return <button type="button" onClick={() => setAsking(true)} disabled={busy} className={`rounded border px-3 py-1.5 text-sm ${tone}`}>{label}</button>;
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={() => { setAsking(false); onConfirm(); }} disabled={busy} className={`rounded border px-3 py-1.5 text-sm font-medium ${tone}`}>{confirmLabel}</button>
      <button type="button" onClick={() => setAsking(false)} className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200">Keep it</button>
    </span>
  );
}

export default function CampaignDetail({ campaignId, askedCanOpen, onBack, onChanged }) {
  const { authFetch } = useAuth();
  const url = `/api/review-campaigns/${encodeURIComponent(campaignId)}`;
  const { data: campaign, loading, error, reload } = useFetch(url, { authFetch });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  async function act(path, method, after) {
    setBusy(true);
    setActionError(null);
    try {
      const r = await authFetch(`${url}${path}`, { method });
      if (!r.ok) { setActionError((await r.json().catch(() => ({}))).error || `That did not work (HTTP ${r.status})`); return; }
      after();
    } catch (err) {
      setActionError(err.message || 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  const back = <button type="button" onClick={onBack} className="text-sm text-blue-700 hover:underline dark:text-blue-300">← All campaigns</button>;
  if (loading && !campaign) return <div className="space-y-3">{back}<p className={MUTED}>Loading the campaign…</p></div>;
  if (error || !campaign) return <div className="space-y-3">{back}<p role="alert" className="text-sm text-red-700 dark:text-red-400">The campaign could not be loaded.</p></div>;

  const { asked, outside } = splitRequests(campaign.requests);
  return (
    <div className="space-y-4" data-testid="campaign-detail">
      {back}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{campaign.name}</h3>
        <div className="flex items-center gap-2">
          {campaign.status !== 'ended' && (
            <ConfirmButton label="End the campaign" confirmLabel="Yes, stop asking" busy={busy} onConfirm={() => act('/end', 'POST', () => { reload(); onChanged(); })} />
          )}
          <ConfirmButton label="Delete" confirmLabel="Yes, delete it" busy={busy} danger onConfirm={() => act('', 'DELETE', () => { onChanged(); onBack(); })} />
        </div>
      </div>
      {actionError && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{actionError}</p>}
      {!askedCanOpen && (
        <p role="alert" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
          An Accountable without an Identity Atlas role cannot open their business roles yet, so they cannot do the review.
          Tick View for Accountable on the Business roles row under Admin → Roles &amp; Permissions → Relative permissions.
        </p>
      )}
      <Facts campaign={campaign} />
      {!campaign.round && <p className={MUTED}>Nobody is asked yet: the first round starts on {formatUtcDay(campaign.startsOn)}.</p>}
      {campaign.status === 'ended' && <p className={MUTED}>Ended on {formatDateOnly(campaign.endedAt)}. Nobody is asked any more; this is how its last round stood.</p>}
      <Outside requests={outside} />
      <Requests requests={asked} />
      {campaign.round && campaign.requests.length === 0 && <p className={MUTED}>This round asked about no role: nothing was in scope when it started.</p>}
    </div>
  );
}
