import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { downloadReport } from '@ui/components/reports/reportExport';
import ReportError from '@ui/components/reports/ReportError';

// "Download report" — the main button of a unit's or an application's header:
// the report headerActions.reportFor() names, as a spreadsheet (the report's
// primary artefact: it opens on its pivot tables), through the same export call
// the report tab's Download button uses, on this context alone (contexts = [id]).
const FORMAT = 'xlsx';

export default function DownloadReportButton({ attrs, report, title }) {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      await downloadReport({ authFetch, name: report, format: FORMAT, params: { contexts: [attrs.id] } });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <button type="button" onClick={download} disabled={busy} title={title} data-testid="download-report"
        className="whitespace-nowrap rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600">
        {busy ? 'Preparing…' : 'Download report'}
      </button>
      {error && <div className="mt-2 max-w-xs"><ReportError title="Download failed" message={error} /></div>}
    </span>
  );
}
