import { useState, useRef } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { Section, ResultRow } from './adminUi';
import { CuratedDataIcon } from './adminIcons';
export default function CuratedDataSection() {
  const [exporting, setExporting]   = useState(false);
  const [importing, setImporting]   = useState(false);
  const [importing2, setImporting2] = useState(false); // file-read step
  const [result, setResult]         = useState(null);
  const [error, setError]           = useState(null);
  const fileInputRef = useRef(null);
  const { authFetch } = useAuth();

  async function handleExport() {
    setError(null);
    setExporting(true);
    try {
      const r = await authFetch('/api/admin/export/curated');
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Export failed');
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `FGCuratedData_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  function handleImportClick() {
    setResult(null);
    setError(null);
    fileInputRef.current?.click();
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so same file can be re-selected
    e.target.value = '';

    setImporting2(true);
    let payload;
    try {
      const text = await file.text();
      payload = JSON.parse(text);
    } catch {
      setError('Could not parse file — make sure it is a valid JSON export.');
      setImporting2(false);
      return;
    }
    setImporting2(false);

    if (!payload.version || (!Array.isArray(payload.tags) && !Array.isArray(payload.categories))) {
      setError('Unrecognised file format. Use a file created by Export-FGCuratedData or this export button.');
      return;
    }

    setImporting(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/import/curated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: payload.tags || [], categories: payload.categories || [] }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Import failed');
      setResult(data.stats);
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  }

  const busy = importing || importing2 || exporting;

  return (
    <Section title="Curated Data" icon={<CuratedDataIcon />} defaultOpen>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Export and import manually curated data — user tags, group/resource tags, and business role categories —
          so they can be restored after recreating an environment.
          Analyst overrides are managed separately via <code className="bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-1 rounded text-xs">Export-FGCuratedData</code>.
        </p>

        {/* Buttons */}
        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleExport}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 hover:border-gray-400 dark:hover:border-gray-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {exporting ? (
              <svg className="w-4 h-4 animate-spin text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            )}
            {exporting ? 'Exporting…' : 'Export tags & categories'}
          </button>

          <button
            onClick={handleImportClick}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? (
              <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            )}
            {busy ? 'Importing…' : 'Import from file'}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-sm text-red-700 dark:text-red-300">
            <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {error}
          </div>
        )}

        {/* Import result */}
        {result && (
          <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg space-y-3">
            <p className="text-sm font-semibold text-green-800 dark:text-green-300">Import complete</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Tags */}
              <div>
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">Tags</p>
                <div className="space-y-1 text-xs text-gray-700 dark:text-gray-300">
                  <ResultRow label="Assignments inserted" value={result.assignmentsInserted} good />
                  {result.assignmentsSoftMatched > 0 && (
                    <ResultRow label="Matched by name (soft)" value={result.assignmentsSoftMatched} warn />
                  )}
                  <ResultRow label="Already existed" value={result.assignmentsSkipped} />
                  {result.assignmentsNotFound > 0 && (
                    <ResultRow label="Entity not found" value={result.assignmentsNotFound} bad />
                  )}
                </div>
              </div>

              {/* Categories */}
              <div>
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">Categories</p>
                <div className="space-y-1 text-xs text-gray-700 dark:text-gray-300">
                  <ResultRow label="AP assignments inserted" value={result.catAssignInserted} good />
                  {result.catAssignSoftMatched > 0 && (
                    <ResultRow label="Matched by name (soft)" value={result.catAssignSoftMatched} warn />
                  )}
                  <ResultRow label="Already existed" value={result.catAssignSkipped} />
                  {result.catAssignNotFound > 0 && (
                    <ResultRow label="Business role not found" value={result.catAssignNotFound} bad />
                  )}
                </div>
              </div>
            </div>

            {(result.assignmentsNotFound > 0 || result.catAssignNotFound > 0) && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Entities not found: run a full sync first so the records exist in SQL, then retry the import.
              </p>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}