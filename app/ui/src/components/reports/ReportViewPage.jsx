// One report, in its own tab (#report:<name>).
//
// Opened from the Reports list, or straight from the URL — a report tab is a
// normal detail tab, so it can be bookmarked, reopened, and kept open next to
// the entities it points at.
//
// Report-agnostic like the rest of this folder: the heading, the columns, the
// rows and the download formats all come from the API response, and the body is
// drawn by whichever renderer the report's `form` resolves to.

import { createElement, useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { formatDate } from '@ui/utils/formatters';
import EmptyState from '@ui/components/EmptyState';
import ReportError from './ReportError';
import { resolveFormRenderer } from './formRenderers';
import { downloadReport } from './reportExport';

export default function ReportViewPage({ reportName, onClose, onOpenDetail, onCacheData }) {
  const { authFetch } = useAuth();
  const [downloading, setDownloading] = useState(null);
  const [downloadError, setDownloadError] = useState(null);

  const { data: report, loading, error, reload } = useFetch(
    `/api/reports/${encodeURIComponent(reportName)}/rows`, { authFetch },
  );

  // A tab opened straight from a URL is labelled with the report's slug; relabel
  // it as soon as the report says what it is called.
  const displayName = report?.displayName;
  useEffect(() => {
    if (displayName) onCacheData?.(reportName, 'report', { displayName });
  }, [displayName, reportName, onCacheData]);

  async function download(format) {
    setDownloading(format);
    setDownloadError(null);
    try {
      await downloadReport({ authFetch, name: reportName, format });
    } catch (err) {
      setDownloadError(err.message);
    } finally {
      setDownloading(null);
    }
  }

  if (error) {
    return <ReportError title="Error running report" message={error.message} onClose={onClose} />;
  }
  if (!report) {
    return <div className="flex h-64 items-center justify-center text-gray-500 dark:text-gray-400">Running report…</div>;
  }

  // Resolved from the report's declared form, then built with createElement —
  // the same shape as the app's page-route dispatch, and the reason this page
  // needs no per-report code.
  const renderer = resolveFormRenderer(report.form);

  return (
    <section className="mx-auto max-w-6xl" aria-label={report.displayName}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{report.displayName}</h2>
          {report.description && (
            <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-400">{report.description}</p>
          )}
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {report.total} {report.total === 1 ? 'row' : 'rows'}
            {report.generatedAt && <> · generated {formatDate(report.generatedAt)}</>}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(report.exportFormats || []).map(format => (
            <DownloadButton
              key={format}
              format={format}
              busy={downloading === format}
              disabled={downloading !== null}
              onDownload={download}
            />
          ))}
          <button
            type="button"
            onClick={reload}
            disabled={loading}
            className="rounded bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {downloadError && (
        <div className="mb-3">
          <ReportError title="Download failed" message={downloadError} />
        </div>
      )}

      {renderer ? (
        createElement(renderer, { report, onOpenDetail })
      ) : (
        <EmptyState
          title="Unsupported report form"
          hint={`This version of the UI has no renderer for the "${report.form}" form. Update Identity Atlas to view it.`}
        />
      )}
    </section>
  );
}

// One button per format the API advertised — the UI never assumes a deployment
// serves CSV, or only CSV.
function DownloadButton({ format, busy, disabled, onDownload }) {
  return (
    <button
      type="button"
      onClick={() => onDownload(format)}
      disabled={disabled}
      className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
    >
      {busy ? 'Preparing…' : `Download ${format.toUpperCase()}`}
    </button>
  );
}
