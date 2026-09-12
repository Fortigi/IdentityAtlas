// Reports page — the catalogue of reports this deployment offers.
//
// The page lists reports and nothing else: opening one runs it in its own tab
// (#report:<name>), so several reports can stay open at once next to the entity
// tabs they point at, and a report's URL can be bookmarked or shared.
//
// Fully report-agnostic: the list comes from GET /api/reports and each entry is
// drawn from that metadata. Adding a report to the deployment adds it to this
// page with no UI change at all.

import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import EmptyState from '@ui/components/EmptyState';
import ReportError from './reports/ReportError';

export default function ReportsPage({ onOpenDetail }) {
  const { authFetch } = useAuth();

  const { data: reports, loading, error } = useFetch('/api/reports', {
    authFetch,
    initialData: [],
    transform: (d) => d.data || [],
  });

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-gray-500 dark:text-gray-400">Loading reports…</div>;
  }
  if (error) return <ReportError title="Error loading reports" message={error.message} />;

  return (
    <div className="mx-auto max-w-6xl">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Reports</h2>
      <p className="mb-4 mt-1 text-sm text-gray-600 dark:text-gray-400">
        Open a report to run it against the latest data in its own tab, where it can be refreshed
        and downloaded.
      </p>

      {reports.length === 0 ? (
        <EmptyState title="No reports available" hint="This deployment has no report templates registered." />
      ) : (
        <ul className="space-y-2">
          {reports.map(report => (
            <li key={report.name}>
              <ReportListItem report={report} onOpenDetail={onOpenDetail} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// A real link, not a button: the report tab is a route, so the browser's own
// "open in a new window/tab" gestures (middle-click, ctrl/cmd-click) work on it.
// A plain left-click is intercepted only to label the tab with the report's
// display name instead of its slug.
function ReportListItem({ report, onOpenDetail }) {
  const open = (e) => {
    if (!onOpenDetail) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onOpenDetail('report', report.name, report.displayName);
  };

  return (
    <a
      href={`#report:${encodeURIComponent(report.name)}`}
      onClick={open}
      className="flex items-start justify-between gap-4 rounded-lg border border-gray-200 bg-white p-4 hover:border-blue-400 hover:bg-blue-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-blue-500 dark:hover:bg-gray-700/50"
    >
      <div>
        <h3 className="text-base font-semibold text-blue-700 dark:text-blue-300">{report.displayName}</h3>
        {report.description && (
          <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-400">{report.description}</p>
        )}
      </div>
      <span className="whitespace-nowrap text-sm text-gray-600 dark:text-gray-400" aria-hidden="true">Open →</span>
    </a>
  );
}
