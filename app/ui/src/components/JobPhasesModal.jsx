import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@ui/auth/AuthGate';

// ─── Job Phases Modal ─────────────────────────────────────────────────────────
// Opens when the operator clicks "Details" on a completed/failed job. Shows
// the per-phase breakdown written by the crawler at end-of-run: status,
// duration, and error text per phase. Falls back to the raw errorMessage
// text when a legacy job pre-dates the phases column.
//
// Lives in its own file (not inside CrawlersPage.jsx) so it can be mounted in
// isolation by the vitest jsdom harness — CrawlersPage.jsx eager-imports every
// crawler's Summary.jsx via import.meta.glob, which can't resolve under vitest.
export function JobPhasesModal({ job, onClose }) {
  const { authFetch } = useAuth();
  const [activeTab, setActiveTab] = useState('phases');
  const [trace, setTrace] = useState({ text: '', totalLength: 0, exists: false });
  const [traceError, setTraceError] = useState(null);
  const traceRef = useRef(null);

  const phases = Array.isArray(job?.phases) ? job.phases : [];
  const isRunning = job && (job.status === 'running' || job.status === 'queued');

  // Incremental trace fetcher. `offset` is the byte we last consumed; the
  // endpoint returns bytes from there to EOF (up to 256 KB) plus the
  // server-side totalLength. We advance offset by what we actually read so
  // the next call only ships new bytes.
  useEffect(() => {
    if (!job || activeTab !== 'trace') return;
    let cancelled = false;
    let timerId = null;
    let currentOffset = 0;
    let currentText = '';

    const poll = async () => {
      try {
        const r = await authFetch(`/api/admin/crawler-jobs/${job.id}/log?offset=${currentOffset}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (cancelled) return;
        currentText += d.text || '';
        currentOffset += (d.text || '').length;
        setTrace({ text: currentText, totalLength: d.totalLength, exists: d.exists });
        setTraceError(null);

        // Keep chasing the tail: if the server had more than we just read
        // (truncated=true) OR the job is still running, schedule another tick.
        // Truncated path fires immediately; running path waits 3s.
        const keepGoing = d.truncated || (isRunning && currentOffset === d.totalLength);
        if (keepGoing && !cancelled) {
          timerId = setTimeout(poll, d.truncated ? 50 : 3000);
        }
      } catch (err) {
        if (!cancelled) {
          setTraceError(err.message);
          if (isRunning) timerId = setTimeout(poll, 5000);
        }
      }
    };
    poll();
    return () => { cancelled = true; if (timerId) clearTimeout(timerId); };
  }, [job, activeTab, isRunning, authFetch]);

  // Auto-scroll the trace pane to the bottom when new bytes arrive, but only
  // if the user hadn't scrolled up to read history.
  useEffect(() => {
    const el = traceRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [trace.text]);

  if (!job) return null;

  const fmtMs = (ms) => {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms} ms`;
    const s = Math.round(ms / 100) / 10;
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s - m * 60);
    return `${m}m ${rem}s`;
  };
  const dot = (status) => {
    if (status === 'ok')      return <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" title="Succeeded" />;
    if (status === 'failed')  return <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500"   title="Failed" />;
    if (status === 'skipped') return <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-400"  title="Skipped" />;
    return <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 dark:bg-gray-600" />;
  };
  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };
  const okCount     = phases.filter(p => p.status === 'ok').length;
  const failedCount = phases.filter(p => p.status === 'failed').length;

  const tabBtn = (id, label) => (
    <button
      onClick={() => setActiveTab(id)}
      className={`px-3 py-1.5 text-sm rounded-t border-b-2 -mb-px transition-colors ${
        activeTab === id
          ? 'border-blue-600 dark:border-blue-500 text-blue-700 dark:text-blue-400 font-medium'
          : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
      }`}
    >{label}</button>
  );

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 dark:bg-opacity-70 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <span>Job {job.id} — {job.jobType}</span>
              {job.config?._syncMode === 'full' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" title="Full sync: re-fetches everything.">full</span>
              )}
              {job.config?._syncMode === 'delta' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300" title="Delta sync: fetches only what changed.">delta</span>
              )}
            </h2>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {new Date(job.createdAt).toLocaleString()} ·
              {' '}<span className={job.status === 'failed' ? 'text-red-600 dark:text-red-400' : job.status === 'completed' ? 'text-green-600 dark:text-green-400' : 'text-gray-600 dark:text-gray-400'}>{job.status}</span>
              {phases.length > 0 && <> · {okCount} ok, {failedCount} failed</>}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 pt-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-1">
          {tabBtn('phases', 'Phases')}
          {tabBtn('trace', 'Trace')}
          {activeTab === 'trace' && trace.exists && (
            <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
              {fmtBytes(trace.totalLength)}{isRunning && <span className="ml-2 text-blue-600 dark:text-blue-400">● live</span>}
            </span>
          )}
        </div>
        <div className="overflow-auto p-6 flex-1">
          {activeTab === 'phases' && (phases.length === 0 ? (
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">No per-phase breakdown available for this job.</p>
              {job.errorMessage && (
                <pre className="bg-red-50 border border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300 text-xs p-3 rounded whitespace-pre-wrap break-words">{job.errorMessage}</pre>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr>
                  <th className="text-left p-2 font-medium w-6"></th>
                  <th className="text-left p-2 font-medium">Phase</th>
                  <th className="text-right p-2 font-medium">Duration</th>
                  <th className="text-left p-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-gray-700">
                {phases.map((p, i) => (
                  <tr key={i} className={p.status === 'failed' ? 'bg-red-50 dark:bg-red-900/20' : ''}>
                    <td className="p-2 align-top">{dot(p.status)}</td>
                    <td className="p-2 font-mono text-xs align-top">{p.name}</td>
                    <td className="p-2 text-right text-gray-600 dark:text-gray-400 align-top">{fmtMs(p.durationMs)}</td>
                    <td className="p-2 align-top">
                      {p.error ? (
                        <span className="text-red-700 dark:text-red-400 text-xs break-words">{p.error}</span>
                      ) : p.records ? (
                        <span className="text-gray-600 dark:text-gray-400 text-xs font-mono">
                          {Object.entries(p.records).map(([k, v]) => `${k}=${v}`).join(' · ')}
                        </span>
                      ) : (
                        <span className="text-gray-500 dark:text-gray-400 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
          {activeTab === 'trace' && (
            !trace.exists ? (
              <div className="text-sm text-gray-500 dark:text-gray-400">
                {isRunning
                  ? 'Waiting for the worker to produce output…'
                  : 'No trace captured for this job. Traces are written by runs after this feature shipped — older jobs have phases only.'}
              </div>
            ) : (
              <pre
                ref={traceRef}
                className="bg-gray-900 text-gray-100 dark:bg-black dark:border dark:border-gray-700 text-xs font-mono p-3 rounded overflow-auto whitespace-pre-wrap break-words max-h-[60vh]"
              >{trace.text || '(empty)'}</pre>
            )
          )}
          {activeTab === 'trace' && traceError && (
            <div className="mt-2 text-xs text-red-600 dark:text-red-400">Failed to refresh trace: {traceError}</div>
          )}
        </div>
      </div>
    </div>
  );
}
