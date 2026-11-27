import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { formatUtcDay } from '@ui/utils/formatters';
import { stepLabel } from '@ui/components/businessRoles/review/reviewSteps';
import CampaignForm from '@ui/components/reviewCampaigns/CampaignForm';
import CampaignDetail from '@ui/components/reviewCampaigns/CampaignDetail';
import { CAMPAIGN_STATUS, progressText, repeatText, scopeText } from '@ui/components/reviewCampaigns/campaigns';

// ─── Reviews ─────────────────────────────────────────────────────────────
// The top-level Reviews tab: review campaigns that ask the Accountable of
// business roles to do a composition review — the list with how each stands, a
// form for a new one, and one campaign with its roles. Experimental: the tab
// exists only while Composition review is on and for whoever may manage
// campaigns (utils/navTabs.js). Data: /api/review-campaigns.

const MUTED = 'text-xs text-gray-600 dark:text-gray-400';

function Row({ campaign, onOpen }) {
  const { round } = campaign;
  return (
    <tr>
      <td className="px-4 py-2">
        <button type="button" onClick={() => onOpen(campaign.id)} className="text-left font-medium text-blue-700 hover:underline dark:text-blue-300">{campaign.name}</button>
        <div className={MUTED}>{campaign.steps.map(stepLabel).join(' · ')}</div>
      </td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{CAMPAIGN_STATUS[campaign.status]}</td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{scopeText(campaign)}</td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{repeatText(campaign.intervalMonths)}</td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-300">
        {round ? `Round ${round.number}, due ${formatUtcDay(round.dueAt)}` : `Starts ${formatUtcDay(campaign.startsOn)}`}
      </td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-300">
        {progressText(round)}
        {round?.noAccountable > 0 && (
          <div className="text-xs font-medium text-red-800 dark:text-red-300">{round.noAccountable} with nobody Accountable</div>
        )}
      </td>
    </tr>
  );
}

function List({ campaigns, onOpen }) {
  if (campaigns.length === 0) {
    return <p className="text-sm text-gray-700 dark:text-gray-300">There are no review campaigns yet. A campaign asks the Accountable of the business roles you choose to review them.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <table className="w-full text-sm" aria-label="Review campaigns">
        <thead className="bg-gray-50 text-left text-xs text-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">Campaign</th>
            <th scope="col" className="px-4 py-2 font-medium">Status</th>
            <th scope="col" className="px-4 py-2 font-medium">Scope</th>
            <th scope="col" className="px-4 py-2 font-medium">How often</th>
            <th scope="col" className="px-4 py-2 font-medium">Round</th>
            <th scope="col" className="px-4 py-2 font-medium">Progress</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
          {campaigns.map(c => <Row key={c.id} campaign={c} onOpen={onOpen} />)}
        </tbody>
      </table>
    </div>
  );
}

function Campaigns() {
  const { authFetch } = useAuth();
  const { data, loading, error, reload } = useFetch('/api/review-campaigns', { authFetch });
  // 'list', 'new', or the id of the campaign that is open.
  const [view, setView] = useState('list');

  if (loading && !data) return <p className={MUTED}>Loading the review campaigns…</p>;
  if (error) return <p role="alert" className="text-sm text-red-700 dark:text-red-400">The review campaigns could not be loaded: {error.message}</p>;
  const campaigns = data?.campaigns ?? [];
  const askedCanOpen = data?.askedCanOpen !== false;

  if (view === 'new') return <CampaignForm onCancel={() => setView('list')} onSaved={(saved) => { reload(); setView(saved.id); }} />;
  if (view !== 'list') return <CampaignDetail campaignId={view} askedCanOpen={askedCanOpen} onBack={() => setView('list')} onChanged={reload} />;
  return (
    <div className="space-y-4" data-testid="review-campaigns">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-gray-600 dark:text-gray-400">
          A campaign asks the Accountable of business roles to review them, once or on a schedule. They see it when they sign in; nothing is sent.
        </p>
        <button type="button" onClick={() => setView('new')} className="rounded bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800">New campaign</button>
      </div>
      <List campaigns={campaigns} onOpen={setView} />
    </div>
  );
}

export default function ReviewsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Reviews</h2>
        <h3 className="mt-1 text-sm font-semibold text-gray-800 dark:text-gray-200">Review campaigns</h3>
      </div>
      <Campaigns />
    </div>
  );
}
