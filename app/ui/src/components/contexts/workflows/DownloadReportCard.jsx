import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { downloadReport } from '@ui/components/reports/reportExport';
import ReportError from '@ui/components/reports/ReportError';

// The spreadsheet is the report's primary artefact (it opens on its pivot
// tables), so the card downloads that one format rather than listing them.
const FORMAT = 'xlsx';

// What the card downloads when the registry says nothing else: the Entitlement
// Pivot, by its unchanged slug.
const ENTITLEMENT_PIVOT = {
  report: 'application-access-review',
  title: 'Download entitlement report',
  text: 'Every entitlement held here and who holds it, with counts and owner, as a spreadsheet.',
  testId: 'action-download-report',
};

// Action card: download a report run on this context — the Entitlement Pivot
// for an application, the unit report for a unit of accounts or people (the
// registry passes `report`, `title`, `text` and `testId`). Runs through the same
// export call the report tab's Download button uses (reports/reportExport.js),
// with the one parameter that matters here: contexts = [this context].
export default function DownloadReportCard({
  attrs,
  report = ENTITLEMENT_PIVOT.report,
  title = ENTITLEMENT_PIVOT.title,
  text = ENTITLEMENT_PIVOT.text,
  testId = ENTITLEMENT_PIVOT.testId,
}) {
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
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800" data-testid={testId}>
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h4>
      <p className="mt-0.5 mb-2 text-xs text-gray-600 dark:text-gray-400">{text}</p>
      <button type="button" onClick={download} disabled={busy}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600">
        {busy ? 'Preparing…' : 'Download (Excel)'}
      </button>
      {error && <div className="mt-2"><ReportError title="Download failed" message={error} /></div>}
    </div>
  );
}
