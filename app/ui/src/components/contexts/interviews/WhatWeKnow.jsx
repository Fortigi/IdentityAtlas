import { useContextClaims } from './claimsContext';
import ClaimReviewList from './ClaimReviewList';
import InterviewList from './InterviewList';
import RoleTimeline from './RoleTimeline';
import { groupConfirmed, proposedClaims, sourceLabel, timelines } from './claims.helpers';

// ─── What we know — the context's page, from its interviews ──────────────
// Confirmed claims, grouped: Description, Properties, People & roles (a role
// timeline per person). Each names its source; its quote is one click away.
// An analyst also gets the claims to review and the interviews themselves.
// A reader (business view, context owner) is sent confirmed claims only, and
// sees no review, no interviews. Renders nothing until there is something to
// show.

function Quote({ claim }) {
  return (
    <details className="text-xs text-gray-600 dark:text-gray-400">
      <summary className="cursor-pointer">{sourceLabel(claim)}</summary>
      {claim.quote && <blockquote className="mt-1 border-l-2 border-gray-300 pl-2 italic text-gray-700 dark:border-gray-600 dark:text-gray-300">{claim.quote}</blockquote>}
    </details>
  );
}

function Group({ title, children }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">{title}</h4>
      {children}
    </div>
  );
}

export default function WhatWeKnow() {
  const ctx = useContextClaims();
  if (!ctx) return null;
  const { description, properties, people } = groupConfirmed(ctx.claims);
  const toReview = ctx.canWrite ? proposedClaims(ctx.claims) : [];
  const interviews = ctx.canWrite ? ctx.interviews : [];
  const personTimelines = timelines(ctx.claims);
  if (description.length + properties.length + people.length + toReview.length + interviews.length === 0) return null;

  return (
    <section aria-label="What we know" className="space-y-3 rounded-lg border border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-gray-800">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">What we know</h3>
      {description.length > 0 && (
        <Group title="Description">
          <ul className="space-y-1">
            {description.map(c => <li key={c.id} className="text-sm text-gray-900 dark:text-gray-200">{c.value}<Quote claim={c} /></li>)}
          </ul>
        </Group>
      )}
      {properties.length > 0 && (
        <Group title="Properties">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {properties.map(c => (
              <div key={c.id} className="contents">
                <dt className="text-gray-600 dark:text-gray-400">{c.attribute}</dt>
                <dd className="text-gray-900 dark:text-gray-200">{c.value}<Quote claim={c} /></dd>
              </div>
            ))}
          </dl>
        </Group>
      )}
      {personTimelines.length > 0 && (
        <Group title="People & roles">
          <ul className="space-y-2">{personTimelines.map(p => <RoleTimeline key={p.key} person={p} />)}</ul>
        </Group>
      )}
      {toReview.length > 0 && <ClaimReviewList claims={toReview} decide={ctx.decide} />}
      {interviews.length > 0 && <InterviewList contextId={ctx.contextId} interviews={interviews} onChanged={ctx.reload} />}
    </section>
  );
}
