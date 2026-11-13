import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { formatDurationMs } from '@ui/utils/formatters';
import AdjustTreePage from '@ui/components/adjustTree/AdjustTreePage';

// ─── Plugin Run Detail Page ───────────────────────────────────────────────────
// Opens in a detail tab via hash #run:<uuid>. Polls
// GET /api/context-plugins/runs/:id every 1s while status is queued/running
// and stops once it reaches a terminal state (succeeded/failed). A run that
// succeeded and names the tree it built (`treeKey`) turns into the Adjust tree
// screen on that tree, under one line about the run.

const TERMINAL = new Set(['succeeded', 'failed']);

export default function RunDetailPage({ runId, onClose }) {
  const { authFetch } = useAuth();
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);

  const fetchRun = useCallback(async () => {
    try {
      const r = await authFetch(`/api/context-plugins/runs/${runId}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      setRun(body);
      setError(null);
      return body;
    } catch (err) {
      setError(err.message || 'Failed to load run');
      return null;
    } finally {
      setLoading(false);
    }
  }, [authFetch, runId]);

  useEffect(() => {
    let cancelled = false;
    async function loop() {
      const body = await fetchRun();
      if (cancelled) return;
      if (body && !TERMINAL.has(body.status)) {
        timerRef.current = setTimeout(loop, 1000);
      }
    }
    loop();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [fetchRun]);

  if (loading && !run) {
    return <div className="p-8 text-sm text-gray-500 dark:text-gray-400">Loading run…</div>;
  }
  if (error && !run) {
    return (
      <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6 max-w-md mx-auto mt-12">
        <h2 className="text-red-800 dark:text-red-300 font-semibold text-lg">Failed to load run</h2>
        <p className="text-red-600 dark:text-red-400 mt-2 text-sm">{error}</p>
        <button onClick={onClose} className="mt-3 text-sm text-gray-500 dark:text-gray-400 underline hover:text-gray-700 dark:hover:text-gray-300">Close</button>
      </div>
    );
  }
  if (!run) return null;

  const statusMeta = STATUS_META[run.status] || STATUS_META.queued;
  const isDone = TERMINAL.has(run.status);
  const durationMs = runDurationMs(run, isDone);

  if (run.status === 'succeeded' && run.treeKey) {
    return (
      <div className="space-y-3">
        <RunSummaryLine run={run} durationMs={durationMs} onClose={onClose} />
        <AdjustTreePage treeKey={run.treeKey} embedded />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{run.algorithmDisplayName || run.algorithmName}</h2>
              <span className={`text-[11px] px-2 py-0.5 rounded border ${statusMeta.className}`}>{statusMeta.label}</span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              Triggered by {run.triggeredBy || 'unknown'} · started {fmt(run.startedAt)}
              {isDone && durationMs != null && <> · took {formatDurationMs(durationMs)}</>}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-600 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-400" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Status / progress */}
      {run.status === 'running' && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-800">
          <span className="inline-block w-3 h-3 mr-2 rounded-full bg-blue-500 animate-pulse" />
          Running… counts below update when the run completes.
        </div>
      )}
      {run.status === 'queued' && (
        <div className="bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
          Queued. Waiting to start.
        </div>
      )}

      {/* Error (if failed) */}
      {run.status === 'failed' && run.errorMessage && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6">
          <h3 className="text-sm font-semibold text-red-800 dark:text-red-300 mb-2">Run failed</h3>
          <pre className="text-xs text-red-700 dark:text-red-400 whitespace-pre-wrap break-words">{run.errorMessage}</pre>
        </div>
      )}

      {/* Counts */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Reconciliation</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <Stat label="Contexts created"  value={run.contextsCreated} />
          <Stat label="Contexts updated"  value={run.contextsUpdated} />
          <Stat label="Contexts removed"  value={run.contextsRemoved} />
          <Stat label="Members added"     value={run.membersAdded} />
          <Stat label="Members removed"   value={run.membersRemoved} />
        </div>
      </div>

      {/* Parameters */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Parameters</h3>
        {run.parameters && Object.keys(run.parameters).length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
            {Object.entries(run.parameters).map(([k, v]) => (
              <div key={k} className="flex items-baseline gap-2 py-1">
                <span className="text-xs text-gray-500 dark:text-gray-400 font-medium min-w-[140px]">{k}</span>
                <span className="text-sm text-gray-900 dark:text-white break-all">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400">No parameters were supplied.</p>
        )}
      </div>

      {run.status === 'succeeded' && (
        <p className="text-center text-xs text-gray-500 dark:text-gray-400">
          Generated contexts are visible in the Contexts tab.{' '}
          <button
            onClick={() => { window.location.hash = 'contexts'; }}
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            Go there now →
          </button>
        </p>
      )}
    </div>
  );
}

const STATUS_META = {
  queued:    { label: 'Queued',    className: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700' },
  running:   { label: 'Running',   className: 'bg-blue-100 text-blue-700 dark:text-blue-300 border-blue-200' },
  succeeded: { label: 'Succeeded', className: 'bg-green-100 text-green-700 border-green-200' },
  failed:    { label: 'Failed',    className: 'bg-red-100 text-red-700 dark:text-red-400 border-red-200 dark:border-red-700' },
};

// How long a finished run took, in ms; null while it runs or without an end.
function runDurationMs(run, isDone) {
  if (!isDone || !run.finishedAt) return null;
  return new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
}

// One line about a finished run, above the tree it built.
function RunSummaryLine({ run, durationMs, onClose }) {
  const counts = [
    `${run.contextsCreated ?? 0} units created`,
    `${run.contextsUpdated ?? 0} updated`,
    `${run.contextsRemoved ?? 0} removed`,
    `${run.membersAdded ?? 0} members added`,
    `${run.membersRemoved ?? 0} removed`,
  ].join(' · ');
  return (
    <div data-testid="run-summary" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
      <span className="font-medium text-gray-900 dark:text-white">{run.algorithmDisplayName || run.algorithmName}</span>
      <span className={`text-[11px] px-2 py-0.5 rounded border ${STATUS_META.succeeded.className}`}>{STATUS_META.succeeded.label}</span>
      <span>{durationMs != null ? `took ${formatDurationMs(durationMs)} · ` : ''}{counts}</span>
      <span className="flex-1" />
      <button type="button" onClick={onClose} className="text-sm text-gray-600 underline hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">Close</button>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-lg font-semibold text-gray-900 dark:text-white">{value ?? 0}</div>
    </div>
  );
}

function fmt(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

