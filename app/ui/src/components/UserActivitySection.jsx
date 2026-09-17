// Sign-in activity for one principal.
//
// Every timestamp is shown with the moment it was MEASURED, because the two are
// not the same fact and the difference is the whole trap: activity is collected
// on a crawl, so someone who signed in an hour ago still reads as untouched for
// weeks if the last crawl was weeks ago. A bare "Last sign-in: 3 weeks ago"
// invites exactly that mistake, so the measurement date travels with it.
//
// Source-agnostic by construction: it renders whatever timestamp fields the API
// returned for whatever activity types exist, including the service-principal
// report's extra flavours (application-auth, delegated-client) that arrive in
// `extendedAttributes`. Nothing here is Entra-specific.

import { useEffect, useState } from 'react';
import { Section } from './DetailSection';
import { formatDate, formatDateOnly, friendlyLabel } from '@ui/utils/formatters';

// The aggregate row's core timestamp columns, in the order an auditor reads
// them. Anything else the source supplied comes from extendedAttributes below.
const CORE_TIMESTAMPS = [
  ['lastSignInDateTime', 'Last interactive sign-in'],
  ['lastNonInteractiveSignInDateTime', 'Last non-interactive sign-in'],
  ['lastSuccessfulSignInDateTime', 'Last successful sign-in'],
  ['lastFailedSignInDateTime', 'Last failed sign-in'],
];

// A value in extendedAttributes is shown as a timestamp when it is an ISO date;
// anything else (a status count, a flag) is shown verbatim. The ISO check comes
// first because Date.parse alone also accepts strings like "3" or "Enabled 1".
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function renderExtendedValue(value) {
  if (typeof value === 'string' && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value))) {
    return formatDate(value);
  }
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function MeasuredOn({ at }) {
  if (!at) return null;
  return (
    <span className="ml-2 text-xs text-gray-600 dark:text-gray-500">
      measured on {formatDateOnly(at)}
    </span>
  );
}

function ActivityRow({ label, value, measuredAt }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
      <span className="text-sm text-gray-600 dark:text-gray-400">{label}</span>
      <span className="text-sm text-gray-900 dark:text-gray-100">
        {value}
        <MeasuredOn at={measuredAt} />
      </span>
    </div>
  );
}

function AggregateBlock({ row }) {
  const extended = row.extendedAttributes && typeof row.extendedAttributes === 'object'
    ? Object.entries(row.extendedAttributes)
    : [];
  const core = CORE_TIMESTAMPS.filter(([key]) => row[key]);

  return (
    <div className="divide-y divide-gray-100 dark:divide-gray-700">
      {core.map(([key, label]) => (
        <ActivityRow key={key} label={label} value={formatDate(row[key])} measuredAt={row.measuredAt} />
      ))}
      {extended.map(([key, value]) => (
        <ActivityRow key={key} label={friendlyLabel(key)} value={renderExtendedValue(value)}
          measuredAt={row.measuredAt} />
      ))}
      {row.signInCount != null && (
        <ActivityRow label="Sign-ins counted" value={String(row.signInCount)} measuredAt={row.measuredAt} />
      )}
      {core.length === 0 && extended.length === 0 && row.signInCount == null && (
        <ActivityRow label="Sign-in timestamps" value="None recorded" measuredAt={row.measuredAt} />
      )}
    </div>
  );
}

function PerAppTable({ rows, onOpenDetail }) {
  return (
    <div className="mt-4">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
        Last used per application
      </h4>
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-600 dark:text-gray-400">
            <th scope="col" className="py-1 pr-3 font-medium">Application</th>
            <th scope="col" className="py-1 pr-3 font-medium">Last sign-in</th>
            <th scope="col" className="py-1 font-medium">Measured on</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {rows.map(row => (
            <tr key={row.resourceId}>
              <td className="py-1.5 pr-3 text-gray-900 dark:text-gray-100">
                {onOpenDetail ? (
                  <button type="button"
                    onClick={() => onOpenDetail('user', row.resourceId, row.appDisplayName || row.resourceId)}
                    className="text-left font-medium text-blue-700 hover:underline dark:text-blue-300">
                    {row.appDisplayName || row.resourceId}
                  </button>
                ) : (row.appDisplayName || row.resourceId)}
              </td>
              <td className="py-1.5 pr-3 text-gray-700 dark:text-gray-300">
                {formatDate(row.lastSignInDateTime || row.lastSuccessfulSignInDateTime) || '—'}
              </td>
              <td className="py-1.5 text-gray-600 dark:text-gray-400">{formatDateOnly(row.measuredAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function UserActivitySection({ userId, authFetch, onOpenDetail }) {
  const [activity, setActivity] = useState(null);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/user/${encodeURIComponent(userId)}/activity`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setActivity(d || { aggregates: [], perApp: [] }); })
      .catch(() => { if (!cancelled) setActivity({ aggregates: [], perApp: [] }); });
    return () => { cancelled = true; };
  }, [userId, authFetch]);

  if (!activity) return null;

  const { aggregates = [], perApp = [] } = activity;

  // An account with no activity row is a normal, meaningful state — the crawler
  // has not collected any, or the source does not report it — so it says so
  // rather than rendering blank or erroring.
  if (aggregates.length === 0 && perApp.length === 0) {
    return (
      <Section title="Activity">
        <p className="text-sm text-gray-600 dark:text-gray-400">No activity recorded.</p>
      </Section>
    );
  }

  return (
    <Section title="Activity">
      {aggregates.map(row => <AggregateBlock key={row.activityType} row={row} />)}
      {perApp.length > 0 && <PerAppTable rows={perApp} onOpenDetail={onOpenDetail} />}
    </Section>
  );
}
