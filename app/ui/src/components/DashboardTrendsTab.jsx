// Dashboard → Trends tab. Plots daily snapshots written by the
// scheduler (see scheduler.js → captureDashboardSnapshotIfMissing).
//
// The chart series start as a single point on the day the snapshot
// table was introduced and grow over time. No historical backfill.

import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import TimeSeriesChart from './TimeSeriesChart';

const RANGE_OPTIONS = [
  { days: 30,  label: '30 days' },
  { days: 90,  label: '90 days' },
  { days: 365, label: '1 year' },
  { days: 730, label: '2 years' },
];

export default function DashboardTrendsTab() {
  const { authFetch } = useAuth();
  const [days, setDays] = useState(90);
  const { data, loading, error } = useFetch(`/api/admin/dashboard-timeseries?days=${days}`, { authFetch });

  const rows = data?.data || [];

  // Derived series. Empty array if no data → the chart renders its empty state.
  const usersSeries        = rows.map(r => ({ date: r.date, value: Number(r.principals)         || 0 }));
  const resourcesSeries    = rows.map(r => ({ date: r.date, value: Number(r.resources)          || 0 }));
  const assignmentsSeries  = rows.map(r => ({ date: r.date, value: Number(r.assignments)        || 0 }));
  const governedSeries     = rows.map(r => ({ date: r.date, value: Number(r.governedAssignments) || 0 }));
  const pctGovernedSeries  = rows.map(r => {
    const total = Number(r.assignments) || 0;
    const gov   = Number(r.governedAssignments) || 0;
    return {
      date: r.date,
      value: total > 0 ? Math.round((gov / total) * 1000) / 10 : 0,  // 1 decimal
    };
  });

  const latest = rows.length ? rows[rows.length - 1] : null;
  const latestPct = latest && Number(latest.assignments) > 0
    ? (Number(latest.governedAssignments) / Number(latest.assignments)) * 100
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xs font-bold text-lime-700 uppercase tracking-widest">Trends</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Daily snapshots. Charts start the day the feature shipped and grow as new days are captured.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="trends-range" className="text-xs text-gray-500 dark:text-gray-400">Range</label>
          <select
            id="trends-range"
            value={days}
            onChange={e => setDays(parseInt(e.target.value, 10))}
            className="text-sm rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 dark:text-gray-200 px-2 py-1"
          >
            {RANGE_OPTIONS.map(o => (
              <option key={o.days} value={o.days}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 dark:border-rose-700 bg-rose-50 dark:bg-rose-900/20 p-3 text-sm text-rose-700 dark:text-rose-300">
          Failed to load: {error.message}
        </div>
      )}

      {/* % Governed — headline chart */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-6 shadow-lg ring-1 ring-gray-200 dark:ring-gray-700">
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-200">Governed assignments — % of total</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">How much of your access is granted through a Business Role.</div>
          </div>
          {latest && (
            <div className="text-right">
              <div className="text-3xl font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                {latestPct.toFixed(1)}<span className="text-base font-normal">%</span>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">today</div>
            </div>
          )}
        </div>
        {loading ? (
          <div className="text-sm text-gray-500 dark:text-gray-400 py-12 text-center">Loading…</div>
        ) : (
          <TimeSeriesChart
            data={pctGovernedSeries}
            color="#10b981"
            yMin={0}
            yMax={100}
            yUnit="%"
            height={240}
          />
        )}
      </div>

      {/* Counts — 3 small charts side by side */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-lg ring-1 ring-gray-200 dark:ring-gray-700">
          <TimeSeriesChart
            data={usersSeries}
            color="#3b82f6"
            yMin={0}
            height={180}
            title="Users (principals)"
            subtitle={latest ? `${(Number(latest.principals) || 0).toLocaleString()} today` : ''}
          />
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-lg ring-1 ring-gray-200 dark:ring-gray-700">
          <TimeSeriesChart
            data={resourcesSeries}
            color="#8b5cf6"
            yMin={0}
            height={180}
            title="Resources"
            subtitle={latest ? `${(Number(latest.resources) || 0).toLocaleString()} today` : ''}
          />
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-lg ring-1 ring-gray-200 dark:ring-gray-700">
          <TimeSeriesChart
            data={assignmentsSeries}
            color="#f59e0b"
            yMin={0}
            height={180}
            title="Assignments"
            subtitle={latest ? `${(Number(latest.assignments) || 0).toLocaleString()} today` : ''}
          />
        </div>
      </div>

      {/* Governed (raw count) — secondary chart */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-lg ring-1 ring-gray-200 dark:ring-gray-700">
        <TimeSeriesChart
          data={governedSeries}
          color="#059669"
          yMin={0}
          height={180}
          title="Governed assignments (raw count)"
          subtitle={latest ? `${(Number(latest.governedAssignments) || 0).toLocaleString()} today` : ''}
        />
      </div>
    </div>
  );
}
