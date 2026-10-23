import { useState } from 'react';
import { useContextClaims } from './claimsContext';
import ClaimReviewList from './ClaimReviewList';
import InterviewList from './InterviewList';
import RoleTimeline from './RoleTimeline';
import { groupConfirmed, proposedClaims, sourceLabel, timelines, whatWeKnowSummary } from './claims.helpers';

// ─── What we know — the context's page, from its interviews ──────────────
// Confirmed claims, grouped: Description, Properties, Also known as, People &
// roles (a role timeline per person). Each names its source; its quote is one
// click away. An analyst also gets the claims to review, the interviews and
// "View transcript". A reader (business view, context owner) is sent confirmed
// claims only, and sees no review, no interviews, no transcript. Renders
// nothing until there is something to show.
//
// Folded by default to one line — "7 facts · 3 people · 2 proposed to review"
// — and opened on click; whether it is open is remembered per context for the
// browser session (sessionStorage; a browser that refuses it just starts folded).

export const OPEN_KEY = (contextId) => `ia.whatWeKnow.open.${contextId}`;

function readOpen(contextId) {
  try { return window.sessionStorage.getItem(OPEN_KEY(contextId)) === '1'; } catch { return false; }
}

function writeOpen(contextId, open) {
  try { window.sessionStorage.setItem(OPEN_KEY(contextId), open ? '1' : '0'); } catch { /* not remembered */ }
}

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

function Known({ description, properties, aliases, personTimelines }) {
  return (
    <>
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
      {aliases.length > 0 && (
        <Group title="Also known as">
          <ul className="space-y-1">{aliases.map(c => <li key={c.id} className="text-sm text-gray-900 dark:text-gray-200">{c.value}<Quote claim={c} /></li>)}</ul>
        </Group>
      )}
      {personTimelines.length > 0 && (
        <Group title="People & roles">
          <ul className="space-y-2">{personTimelines.map(p => <RoleTimeline key={p.key} person={p} />)}</ul>
        </Group>
      )}
    </>
  );
}

export default function WhatWeKnow() {
  const ctx = useContextClaims();
  const [open, setOpen] = useState(() => (ctx ? readOpen(ctx.contextId) : false));
  if (!ctx) return null;
  const { description, properties, aliases, people } = groupConfirmed(ctx.claims);
  const toReview = ctx.canWrite ? proposedClaims(ctx.claims) : [];
  const interviews = ctx.canWrite ? ctx.interviews : [];
  const personTimelines = timelines(ctx.claims);
  if (description.length + properties.length + aliases.length + people.length + toReview.length + interviews.length === 0) return null;

  function toggle() {
    setOpen(o => { writeOpen(ctx.contextId, !o); return !o; });
  }
  const latest = interviews[0];
  return (
    <section aria-label="What we know" className="space-y-3 rounded-lg border border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={`what-we-know-${ctx.contextId}`}
          className="flex flex-wrap items-baseline gap-x-2 text-left">
          <span aria-hidden="true" className="text-xs text-gray-600 dark:text-gray-400">{open ? '▼' : '▶'}</span>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">What we know</h3>
          <span className="text-xs text-gray-600 dark:text-gray-400" data-testid="what-we-know-summary">{whatWeKnowSummary(ctx.claims, ctx.canWrite)}</span>
        </button>
        {ctx.openTranscript && latest && (
          <button type="button" onClick={() => ctx.openTranscript(latest.id)}
            className="text-xs text-blue-700 underline hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200">View transcript</button>
        )}
      </div>
      {open && (
        <div id={`what-we-know-${ctx.contextId}`} className="space-y-3">
          <Known description={description} properties={properties} aliases={aliases} personTimelines={personTimelines} />
          {toReview.length > 0 && <ClaimReviewList claims={toReview} decide={ctx.decide} rejectMany={ctx.rejectMany} openTranscript={ctx.openTranscript} />}
          {interviews.length > 0 && <InterviewList contextId={ctx.contextId} interviews={interviews} onChanged={ctx.reload} onViewTranscript={ctx.openTranscript} />}
        </div>
      )}
    </section>
  );
}
