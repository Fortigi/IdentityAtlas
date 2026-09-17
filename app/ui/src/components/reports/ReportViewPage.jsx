// One report, in its own tab (#report:<name>).
//
// Opened from the Reports list, or straight from the URL — a report tab is a
// normal detail tab, so it can be bookmarked, reopened, and kept open next to
// the entities it points at.
//
// Report-agnostic like the rest of this folder: the heading, the columns, the
// rows and the download formats all come from the API response, and the body is
// drawn by whichever renderer the report's `form` resolves to.

import { createElement, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanBuildReports } from '@ui/hooks/useCanBuildReports';
import { formatDate } from '@ui/utils/formatters';
import EmptyState from '@ui/components/EmptyState';
import SchemaConfigForm from '@ui/components/SchemaConfigForm';
import ReportError from './ReportError';
import ReportNotices from './ReportNotices';
import { resolveFormRenderer } from './formRenderers';
import { downloadReport } from './reportExport';
import { paramsQueryString, withSchemaDefaults } from './reportParams';

export default function ReportViewPage({ reportName, onClose, onOpenDetail, onCacheData }) {
  const { authFetch } = useAuth();
  // The same test the Reports list applies: a reader who opens a custom report
  // runs and downloads it, and is not offered an editor they cannot save from.
  const canBuild = useCanBuildReports();
  const [downloading, setDownloading] = useState(null);
  const [downloadError, setDownloadError] = useState(null);
  // What the user set, not what the report ran with: an untouched parameter
  // stays out of the query string so the server's declared default applies.
  const [params, setParams] = useState({});

  const query = paramsQueryString(params);
  const { data: report, loading, error, reload } = useFetch(
    `/api/reports/${encodeURIComponent(reportName)}/rows${query}`, { authFetch },
  );

  // The form shows the effective values — schema defaults until overridden —
  // so a threshold is visible and editable before it has been touched.
  const schema = report?.parametersSchema;
  const formValues = useMemo(() => withSchemaDefaults(schema, params), [schema, params]);

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
      await downloadReport({ authFetch, name: reportName, format, params });
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
            {report.truncated ? 'First ' : ''}{report.total} {report.total === 1 ? 'row' : 'rows'}
            {report.generatedAt && <> · generated {formatDate(report.generatedAt)}</>}
          </p>
          {report.truncated && (
            <p role="status" className="mt-2 max-w-3xl rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
              This report stopped at {report.total} rows, so there are more than shown here — and more than
              the download contains. Narrow it with another condition to see all of them.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {report.editable && canBuild && onOpenDetail && (
            <button
              type="button"
              onClick={() => onOpenDetail('report-builder', report.editable.builderId, report.displayName)}
              className="rounded bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            >
              Edit
            </button>
          )}
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

      {/* Parameters apply on change: the fetch URL carries them, so editing a
          threshold re-runs the report the same way Refresh does. */}
      {Object.keys(schema?.properties || {}).length > 0 && (
        <div className="mb-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <SchemaConfigForm
            schema={schema}
            params={formValues}
            onChange={setParams}
            idPrefix={`report-${reportName}`}
          />
        </div>
      )}

      <ReportNotices notices={report.notices} />

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
