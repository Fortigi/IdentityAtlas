// Scope Statistics panel for the Matrix view.
//
// For the current matrix selection it shows live counts (principals / resources
// / assignments) and the governed-vs-non-governed split, and — on expand —
// a historic timeline (reconstructed from the audit log by the API) plus a
// department-by-department breakdown that drills into each department's trend.
//
// Endpoints (see app/api/src/routes/matrix.js):
//   POST /api/matrix/scope-stats        — live counts + governed split
//   POST /api/matrix/scope-timeseries   — reconstructed historic timeline
//   POST /api/matrix/scope-breakdown    — per-department breakdown

import { Fragment, useEffect, useMemo, useState, useReducer, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDebouncedValue } from '@ui/hooks/useDebouncedValue';
import TimeSeriesChart from '@ui/components/TimeSeriesChart';

// Aligned with the Dashboard Trends palette (TimeSeriesChart colours):
//   governed → emerald, principals → blue, resources → violet, assignments → amber.
const GOV_FILL = '#10b981';    // emerald-500 — governed (matches "% Governed" trend)
const UNGOV_FILL = '#f59e0b';  // amber-500 — not yet governed
const PRINCIPALS_COLOR = '#3b82f6';  // blue-500
const RESOURCES_COLOR = '#8b5cf6';   // violet-500
const ASSIGNMENTS_COLOR = '#f59e0b'; // amber-500
// Text shades meet WCAG AA on white; dark-mode override for legibility.
const GOV_TEXT = 'text-emerald-700 dark:text-emerald-400';
const UNGOV_TEXT = 'text-amber-700 dark:text-amber-400';

function pct(n) { return `${Math.round((n + Number.EPSILON) * 10) / 10}%`; }
function num(n) { return (n ?? 0).toLocaleString(); }

// One headline number.
function Stat({ label, value, sub }) {
  return (
    <div className="flex flex-col">
      <span className="text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">{value}</span>
      <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
      {sub && <span className="text-xs text-gray-500 dark:text-gray-400">{sub}</span>}
    </div>
  );
}

// Governed vs non-governed bar.
function GovernedBar({ governed, ungoverned, governedPct }) {
  const total = governed + ungoverned;
  const gWidth = total > 0 ? (governed / total) * 100 : 0;
  return (
    <div className="flex flex-col gap-1 min-w-[220px]">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-gray-500 dark:text-gray-400">Governed vs non-governed</span>
        <span className={`text-sm font-semibold tabular-nums ${GOV_TEXT}`}>{pct(governedPct)}</span>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700" role="img"
           aria-label={`${pct(governedPct)} governed`}>
        <div style={{ width: `${gWidth}%`, backgroundColor: GOV_FILL }} />
        <div style={{ width: `${100 - gWidth}%`, backgroundColor: UNGOV_FILL }} />
      </div>
      <div className="flex justify-between text-xs">
        <span className={GOV_TEXT}>{num(governed)} governed</span>
        <span className={UNGOV_TEXT}>{num(ungoverned)} non-governed</span>
      </div>
    </div>
  );
}

// A compact count chart for one metric.
function MetricChart({ title, points, metric, color, isPct }) {
  const data = useMemo(
    () => points.filter(p => !p.beforeHistory).map(p => ({ date: p.date, value: p[metric] })),
    [points, metric],
  );
  if (data.length === 0) return null;
  return (
    <TimeSeriesChart
      data={data}
      title={title}
      height={isPct ? 200 : 150}
      color={color}
      yMin={0}
      yMax={isPct ? 100 : null}
      yUnit={isPct ? '%' : ''}
    />
  );
}

// Live-stats fetch state. A reducer (rather than useState) keeps the
// synchronous loading/idle transitions out of the effect body, so they don't
// trip react-hooks/set-state-in-effect.
function statsReducer(s, a) {
  switch (a.type) {
    case 'idle':    return { data: null, loading: false };
    case 'loading': return { data: s.data, loading: true };
    case 'success': return { data: a.data, loading: false };
    case 'settled': return { data: s.data, loading: false }; // fetch rejected — keep prior data
    default:        return s;
  }
}

// Trends + breakdown + department drill-down fetch state, in one reducer for the
// same reason. `drill` lives here so the fetch can clear it without a
// synchronous setState in the effect.
function trendsReducer(s, a) {
  switch (a.type) {
    case 'loading':  return { ...s, loading: true, drill: null };
    case 'success':  return { series: a.series, breakdown: a.breakdown, loading: false, drill: s.drill };
    case 'settled':  return { ...s, loading: false };
    case 'setDrill': return { ...s, drill: a.drill };
    default:         return s;
  }
}

export default function MatrixScopePanel({ filter }) {
  const { authFetch } = useAuth();
  const debouncedFilter = useDebouncedValue(filter, 400);
  const filterKey = useMemo(() => JSON.stringify(debouncedFilter || null), [debouncedFilter]);

  const [statsState, statsDispatch] = useReducer(statsReducer, { data: null, loading: false });
  const stats = statsState.data;
  const statsLoading = statsState.loading;
  const [expanded, setExpanded] = useState(false);

  const [trendsState, trendsDispatch] = useReducer(
    trendsReducer, { series: null, breakdown: null, loading: false, drill: null });
  const series = trendsState.series;        // { points, historyStart, retentionDays, scopeMode }
  const breakdown = trendsState.breakdown;  // { attribute, groups }
  const trendsLoading = trendsState.loading;
  const drill = trendsState.drill;          // { key, points } for an expanded department

  const post = useCallback((path, body) =>
    authFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => (r.ok ? r.json() : null)), [authFetch]);

  // Live stats — refetch whenever the (debounced) filter changes.
  useEffect(() => {
    if (!debouncedFilter) { statsDispatch({ type: 'idle' }); return undefined; }
    let cancelled = false;
    statsDispatch({ type: 'loading' });
    post('/api/matrix/scope-stats', { filter: debouncedFilter })
      .then(d => { if (!cancelled) statsDispatch({ type: 'success', data: d }); })
      .catch(() => { if (!cancelled) statsDispatch({ type: 'settled' }); });
    return () => { cancelled = true; };
  }, [filterKey, debouncedFilter, post]);

  // Trends + breakdown — only once the panel is expanded, and on filter change.
  useEffect(() => {
    if (!expanded || !debouncedFilter) return undefined;
    let cancelled = false;
    trendsDispatch({ type: 'loading' });
    Promise.all([
      post('/api/matrix/scope-timeseries', { filter: debouncedFilter }),
      post('/api/matrix/scope-breakdown?attribute=department', { filter: debouncedFilter }),
    ]).then(([ts, bd]) => {
      if (cancelled) return;
      trendsDispatch({ type: 'success', series: ts, breakdown: bd });
    }).catch(() => { if (!cancelled) trendsDispatch({ type: 'settled' }); });
    return () => { cancelled = true; };
  }, [expanded, filterKey, debouncedFilter, post]);

  const toggleDrill = useCallback(async (groupKey) => {
    if (!groupKey || groupKey === '(none)') return;
    if (drill?.key === groupKey) { trendsDispatch({ type: 'setDrill', drill: null }); return; }
    const attr = breakdown?.attribute || 'department';
    const deptFilter = {
      ...debouncedFilter,
      subject: {
        include: [...(debouncedFilter.subject?.include || []), { kind: 'attribute', field: attr, values: [groupKey] }],
        exclude: debouncedFilter.subject?.exclude || [],
      },
    };
    trendsDispatch({ type: 'setDrill', drill: { key: groupKey, points: null } });
    const ts = await post('/api/matrix/scope-timeseries', { filter: deptFilter });
    trendsDispatch({ type: 'setDrill', drill: { key: groupKey, points: ts?.points || [] } });
  }, [drill, breakdown, debouncedFilter, post]);

  if (!filter) return null;

  const s = stats || {};
  const subjectLabel = (s.rowType === 'identity') ? 'Identities' : 'Principals';

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <ScopeSummaryRow
        stats={s}
        statsLoading={statsLoading}
        hasStats={!!stats}
        subjectLabel={subjectLabel}
        expanded={expanded}
        onToggle={() => setExpanded(e => !e)}
      />

      {expanded && (
        <ScopeExpandedPanel
          trendsLoading={trendsLoading}
          series={series}
          subjectLabel={subjectLabel}
          breakdown={breakdown}
          drill={drill}
          onDrill={toggleDrill}
        />
      )}
    </div>
  );
}

// Summary row: the always-visible headline stats, governed bar and expand toggle.
function ScopeSummaryRow({ stats, statsLoading, hasStats, subjectLabel, expanded, onToggle }) {
  const showPlaceholder = statsLoading && !hasStats;
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-4 p-4">
      <Stat label={subjectLabel} value={showPlaceholder ? '—' : num(stats.subjectCount)} />
      <Stat label="Resources" value={showPlaceholder ? '—' : num(stats.resourceCount)} />
      <Stat label="Assignments" value={showPlaceholder ? '—' : num(stats.assignmentCount)} />
      <div className="flex-1 min-w-[220px]">
        <GovernedBar
          governed={stats.governedAssignmentCount || 0}
          ungoverned={stats.ungovernedAssignmentCount || 0}
          governedPct={stats.governedPct || 0}
        />
      </div>
      <button
        onClick={onToggle}
        className="ml-auto px-3 py-1.5 rounded text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
      >
        {expanded ? 'Hide trends & breakdown' : 'Trends & breakdown'}
      </button>
    </div>
  );
}

// Expanded panel: history caveats, timeline charts and the department breakdown.
function ScopeExpandedPanel({ trendsLoading, series, subjectLabel, breakdown, drill, onDrill }) {
  return (
    <div className="border-t border-gray-200 dark:border-gray-700 p-4 flex flex-col gap-6">
      {trendsLoading && <div className="text-sm text-gray-500 dark:text-gray-400">Reconstructing history…</div>}

      {/* History boundary / scope-mode caveats */}
      {series && (
        <HistoryNote series={series} />
      )}

      {/* Timeline charts */}
      {series && series.points?.some(p => !p.beforeHistory) && (
        <div className="flex flex-col gap-4">
          <MetricChart title="Governed % over time" points={series.points} metric="governedPct" color={GOV_FILL} isPct />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <MetricChart title={subjectLabel} points={series.points} metric="principals" color={PRINCIPALS_COLOR} />
            <MetricChart title="Resources" points={series.points} metric="resources" color={RESOURCES_COLOR} />
            <MetricChart title="Assignments" points={series.points} metric="assignments" color={ASSIGNMENTS_COLOR} />
          </div>
        </div>
      )}

      {/* Department breakdown */}
      {breakdown && breakdown.groups?.length > 0 && (
        <DepartmentBreakdown
          breakdown={breakdown}
          drill={drill}
          onDrill={onDrill}
        />
      )}
    </div>
  );
}

function HistoryNote({ series }) {
  const start = series.historyStart ? new Date(series.historyStart) : null;
  return (
    <div className="text-xs text-gray-500 dark:text-gray-400 flex flex-col gap-1">
      {start && (
        <span>
          History reconstructed from the change-audit log
          {series.retentionDays > 0 && <> (retained {series.retentionDays} days)</>}.
          Data available from <span className="font-medium text-gray-700 dark:text-gray-300">{start.toLocaleDateString()}</span>.
        </span>
      )}
      {series.scopeMode === 'context-current' && (
        <span className="text-amber-700 dark:text-amber-400">
          This selection scopes by context membership, which isn't audited — historic membership is approximated using today's members.
        </span>
      )}
    </div>
  );
}

function DepartmentBreakdown({ breakdown, drill, onDrill }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
        By {breakdown.attribute} — governed vs non-governed
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
              <th className="py-2 pr-4 font-medium">{breakdown.attribute}</th>
              <th className="py-2 pr-4 font-medium text-right">Principals</th>
              <th className="py-2 pr-4 font-medium text-right">Assignments</th>
              <th className="py-2 pr-4 font-medium w-56">Governed</th>
              <th className="py-2 font-medium text-right">%</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
            {breakdown.groups.map((g) => {
              const drillable = g.group !== '(none)' && g.assignments > 0;
              const isOpen = drill?.key === g.group;
              const gWidth = g.assignments > 0 ? (g.governed / g.assignments) * 100 : 0;
              return (
                <Fragment key={g.group}>
                  <tr
                    className={`${drillable ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40' : ''}`}
                    onClick={() => drillable && onDrill(g.group)}
                  >
                    <td className="py-2 pr-4 text-gray-900 dark:text-gray-100">
                      {drillable && <span className="inline-block w-3 text-gray-500 dark:text-gray-400">{isOpen ? '▾' : '▸'}</span>}
                      {g.group}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-gray-700 dark:text-gray-300">{num(g.principals)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-gray-700 dark:text-gray-300">{num(g.assignments)}</td>
                    <td className="py-2 pr-4">
                      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                        <div style={{ width: `${gWidth}%`, backgroundColor: GOV_FILL }} />
                        <div style={{ width: `${100 - gWidth}%`, backgroundColor: UNGOV_FILL }} />
                      </div>
                    </td>
                    <td className={`py-2 text-right tabular-nums font-medium ${GOV_TEXT}`}>{pct(g.governedPct)}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={5} className="bg-gray-50 dark:bg-gray-900/30 px-4 py-3">
                        {drill.points == null ? (
                          <div className="text-xs text-gray-500 dark:text-gray-400">Loading {g.group} trend…</div>
                        ) : drill.points.some(p => !p.beforeHistory) ? (
                          <MetricChart
                            title={`${g.group} — governed % over time`}
                            points={drill.points}
                            metric="governedPct"
                            color={GOV_FILL}
                            isPct
                          />
                        ) : (
                          <div className="text-xs text-gray-500 dark:text-gray-400">No history available for {g.group}.</div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
