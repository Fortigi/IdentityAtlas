// Reports page — the catalogue of reports this deployment offers.
//
// The page lists reports and nothing else: opening one runs it in its own tab
// (#report:<name>), so several reports can stay open at once next to the entity
// tabs they point at, and a report's URL can be bookmarked or shared.
//
// Fully report-agnostic: the list comes from GET /api/reports and each entry is
// drawn from that metadata. Adding a report to the deployment adds it to this
// page with no UI change at all.
//
// Custom reports (experimental) are listed apart from the standard ones, with who
// built them and who changed them last — they are shared across the deployment, so
// "whose is this?" is the first question about one. "New report" and "Edit" open
// the report builder in its own tab (#report-builder:<id>).

import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useDialog } from '@ui/components/dialogContext';
import { useCanBuildReports } from '@ui/hooks/useCanBuildReports';
import EmptyState from '@ui/components/EmptyState';
import { formatDateOnly } from '@ui/utils/formatters';
import ReportError from './reports/ReportError';

const SECONDARY = 'rounded bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600';
const SECTION_TITLE = 'text-base font-semibold text-gray-900 dark:text-white';
const SECTION_HINT = 'mt-0.5 text-sm text-gray-600 dark:text-gray-400';

export default function ReportsPage({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const canBuild = useCanBuildReports();

  const { data: reports, loading, error, reload } = useFetch('/api/reports', {
    authFetch,
    initialData: [],
    transform: (d) => d.data || [],
  });

  const newReport = () => onOpenDetail?.('report-builder', `new-${Date.now()}`, 'New report');

  const deleteReport = async (report) => {
    if (!(await dialog.confirm({ message: `Delete the report "${report.displayName}"? This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    const res = await authFetch(`/api/nl-reports/saved/${encodeURIComponent(report.editable.builderId)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      dialog.alert(body.error || 'Failed to delete the report');
      return;
    }
    reload();
  };

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-gray-500 dark:text-gray-400">Loading reports…</div>;
  }
  if (error) return <ReportError title="Error loading reports" message={error.message} />;

  const standard = reports.filter(r => r.source !== 'custom');
  const custom = reports.filter(r => r.source === 'custom');
  // The custom section is there for whoever can add to it, or whenever there is
  // something in it. A reader on an install without the feature sees no trace of it.
  const showCustom = canBuild || custom.length > 0;

  return (
    <div className="mx-auto max-w-6xl">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Reports</h2>
      <p className="mb-6 mt-1 text-sm text-gray-600 dark:text-gray-400">
        Open a report to run it against the latest data in its own tab, where it can be refreshed
        and downloaded.
      </p>

      {standard.length === 0 && !showCustom ? (
        <EmptyState title="No reports available" hint="This deployment has no report templates registered." />
      ) : (
        <div className="space-y-8">
          {standard.length > 0 && (
            <section aria-labelledby="reports-standard">
              <h3 id="reports-standard" className={SECTION_TITLE}>Standard reports</h3>
              <p className={`${SECTION_HINT} mb-3`}>Included with Identity Atlas.</p>
              <ul className="space-y-2">
                {standard.map(report => (
                  <li key={report.name} className="flex items-stretch gap-2">
                    <ReportListItem report={report} onOpenDetail={onOpenDetail} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {showCustom && (
            <section aria-labelledby="reports-custom">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 id="reports-custom" className={SECTION_TITLE}>Custom reports</h3>
                  <p className={SECTION_HINT}>Built by people in this deployment, and shared with everyone who can read data.</p>
                </div>
                {canBuild && (
                  <button type="button" onClick={newReport}
                    className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600">
                    New report
                  </button>
                )}
              </div>
              {custom.length === 0 ? (
                <p className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-400">
                  No custom reports yet. Build one when the standard reports do not answer your question.
                </p>
              ) : (
                <ul className="space-y-2">
                  {custom.map(report => (
                    <li key={report.name} className="flex items-stretch gap-2">
                      <ReportListItem report={report} onOpenDetail={onOpenDetail} />
                      {report.editable && canBuild && (
                        <div className="flex flex-col justify-center gap-1.5">
                          <button type="button" className={SECONDARY} aria-label={`Edit ${report.displayName}`}
                            onClick={() => onOpenDetail?.('report-builder', report.editable.builderId, report.displayName)}>
                            Edit
                          </button>
                          <button type="button" aria-label={`Delete ${report.displayName}`} onClick={() => deleteReport(report)}
                            className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/20">
                            Delete
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "By ann · last edited by bob on 16 Sep 2026". Names only what is known, and does
 * not repeat the author when they were also the last to edit.
 */
function authorLine(author) {
  if (!author) return null;
  const { createdBy, updatedBy, updatedAt } = author;
  const parts = [];
  if (createdBy) parts.push(`By ${createdBy}`);
  const date = updatedAt ? formatDateOnly(updatedAt) : '';
  const editor = updatedBy && updatedBy !== createdBy ? ` by ${updatedBy}` : '';
  if (editor || date) parts.push(`last edited${editor}${date ? ` on ${date}` : ''}`);
  if (parts.length === 0) return null;
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
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
  const byline = authorLine(report.author);

  return (
    <a
      href={`#report:${encodeURIComponent(report.name)}`}
      onClick={open}
      className="flex flex-1 items-start justify-between gap-4 rounded-lg border border-gray-200 bg-white p-4 hover:border-blue-400 hover:bg-blue-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-blue-500 dark:hover:bg-gray-700/50"
    >
      <div>
        <h4 className="text-base font-semibold text-blue-700 dark:text-blue-300">{report.displayName}</h4>
        {report.description && (
          <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-400">{report.description}</p>
        )}
        {byline && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{byline}</p>}
      </div>
      <span className="whitespace-nowrap text-sm text-gray-600 dark:text-gray-400" aria-hidden="true">Open →</span>
    </a>
  );
}
