// Reports page — pick a report, see its content.
//
// Fully report-agnostic: the list comes from GET /api/reports and the content
// is drawn by the renderer that the report's `form` resolves to. Adding a
// report to the deployment adds it to this page with no UI change at all.

import { createElement, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { formatDate } from '@ui/utils/formatters';
import EmptyState from '@ui/components/EmptyState';
import { resolveFormRenderer } from './reports/formRenderers';

export default function ReportsPage({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const [picked, setPicked] = useState(null);

  const { data: reports, loading: listLoading, error: listError } = useFetch('/api/reports', {
    authFetch,
    initialData: [],
    transform: (d) => d.data || [],
  });

  // Derived rather than synced in an effect: the first report is selected until
  // the user picks another one.
  const selected = reports.find(r => r.name === picked) || reports[0] || null;
  const {
    data: report, loading: rowsLoading, error: rowsError, reload,
  } = useFetch(selected ? `/api/reports/${encodeURIComponent(selected.name)}/rows` : null, { authFetch });

  if (listLoading) {
    return <div className="flex h-64 items-center justify-center text-gray-500 dark:text-gray-400">Loading reports…</div>;
  }
  if (listError) return <ReportsError title="Error loading reports" message={listError.message} />;

  return (
    <div className="mx-auto max-w-6xl">
      <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Reports</h2>

      {reports.length === 0 ? (
        <EmptyState title="No reports available" hint="This deployment has no report templates registered." />
      ) : (
        <>
          <ReportPicker reports={reports} selected={selected} onPick={setPicked} />
          <ReportContent
            report={report}
            selected={selected}
            loading={rowsLoading}
            error={rowsError}
            onRefresh={reload}
            onOpenDetail={onOpenDetail}
          />
        </>
      )}
    </div>
  );
}

// Only rendered when there is at least one report, so `selected` is never null
// here (it falls back to reports[0]).
function ReportPicker({ reports, selected, onPick }) {
  return (
    <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Reports">
      {reports.map(r => <ReportTab key={r.name} report={r} selected={r.name === selected.name} onPick={onPick} />)}
    </div>
  );
}

// One selectedness test feeds both the accessible state and the styling, so the
// two can't disagree about which report is showing.
function ReportTab({ report, selected, onPick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={() => onPick(report.name)}
      className={`rounded-full px-3 py-1 text-sm font-medium ${
        selected
          ? 'bg-blue-600 text-white dark:bg-blue-700'
          : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
      }`}
    >
      {report.displayName}
    </button>
  );
}

function ReportContent({ report, selected, loading, error, onRefresh, onOpenDetail }) {
  // Resolved from the report's declared form, then built with createElement —
  // the same shape as App.jsx's page-route dispatch, and the reason the UI
  // needs no per-report code.
  const renderer = resolveFormRenderer(report?.form);

  return (
    <section aria-label={selected.displayName}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">{selected.displayName}</h3>
          {selected.description && (
            <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-400">{selected.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <ReportsError title={`Error running ${selected.displayName}`} message={error.message} />
      ) : loading && !report ? (
        <div className="flex h-40 items-center justify-center text-gray-500 dark:text-gray-400">Running report…</div>
      ) : report ? (
        <>
          <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
            {report.total} {report.total === 1 ? 'row' : 'rows'}
            {report.generatedAt && <> · generated {formatDate(report.generatedAt)}</>}
          </p>
          {renderer ? (
            createElement(renderer, { report, onOpenDetail })
          ) : (
            <EmptyState
              title="Unsupported report form"
              hint={`This version of the UI has no renderer for the "${report.form}" form. Update Identity Atlas to view it.`}
            />
          )}
        </>
      ) : null}
    </section>
  );
}

function ReportsError({ title, message }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-700 dark:bg-red-900/30">
      <h3 className="font-semibold text-red-800 dark:text-red-300">{title}</h3>
      <p className="mt-1 text-sm text-red-600 dark:text-red-400">{message}</p>
    </div>
  );
}
