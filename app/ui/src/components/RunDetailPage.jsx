import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '../auth/AuthGate';

// ─── Plugin Run Detail Page ───────────────────────────────────────────────────
// Opens in a detail tab via hash #run:<uuid>. Polls
// GET /api/context-plugins/runs/:id every 1s while status is queued/running
// and stops once it reaches a terminal state (succeeded/failed).

const TERMINAL = new Set(['succeeded', 'failed']);

export default function RunDetailPage({ runId, onClose, onOpenDetail }) {
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
    return <div className="p-8 text-sm text-gray-500">Loading run…</div>;
  }
  if (error && !run) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md mx-auto mt-12">
        <h2 className="text-red-800 font-semibold text-lg">Failed to load run</h2>
        <p className="text-red-600 mt-2 text-sm">{error}</p>
        <button onClick={onClose} className="mt-3 text-sm text-gray-500 underline hover:text-gray-700">Close</button>
      </div>
    );
  }
  if (!run) return null;

  const statusMeta = STATUS_META[run.status] || STATUS_META.queued;
  const isDone = TERMINAL.has(run.status);
  const durationMs = isDone && run.finishedAt
    ? (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-semibold text-gray-900">{run.algorithmDisplayName || run.algorithmName}</h2>
              <span className={`text-[11px] px-2 py-0.5 rounded border ${statusMeta.className}`}>{statusMeta.label}</span>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Triggered by {run.triggeredBy || 'unknown'} · started {fmt(run.startedAt)}
              {isDone && durationMs != null && <> · took {formatDuration(durationMs)}</>}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
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
        <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 text-sm text-gray-700">
          Queued. Waiting to start.
        </div>
      )}

      {/* Error (if failed) */}
      {run.status === 'failed' && run.errorMessage && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <h3 className="text-sm font-semibold text-red-800 mb-2">Run failed</h3>
          <pre className="text-xs text-red-700 whitespace-pre-wrap break-words">{run.errorMessage}</pre>
        </div>
      )}

      {/* Counts */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Reconciliation</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <Stat label="Contexts created"  value={run.contextsCreated} />
          <Stat label="Contexts updated"  value={run.contextsUpdated} />
          <Stat label="Contexts removed"  value={run.contextsRemoved} />
          <Stat label="Members added"     value={run.membersAdded} />
          <Stat label="Members removed"   value={run.membersRemoved} />
        </div>
      </div>

      {/* Parameters */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Parameters</h3>
        {run.parameters && Object.keys(run.parameters).length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
            {Object.entries(run.parameters).map(([k, v]) => (
              <div key={k} className="flex items-baseline gap-2 py-1">
                <span className="text-xs text-gray-500 font-medium min-w-[140px]">{k}</span>
                <span className="text-sm text-gray-900 break-all">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-500">No parameters were supplied.</p>
        )}
      </div>

      {run.status === 'succeeded' && (
        <p className="text-center text-xs text-gray-500">
          Generated contexts are visible in the Contexts tab.
          {onOpenDetail && (
            <>
              {' '}
              <button
                onClick={() => onOpenDetail?.('context', null)}
                className="text-blue-600 hover:underline"
              >
                Go there now →
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

const STATUS_META = {
  queued:    { label: 'Queued',    className: 'bg-gray-100 text-gray-700 border-gray-200' },
  running:   { label: 'Running',   className: 'bg-blue-100 text-blue-700 border-blue-200' },
  succeeded: { label: 'Succeeded', className: 'bg-green-100 text-green-700 border-green-200' },
  failed:    { label: 'Failed',    className: 'bg-red-100 text-red-700 border-red-200' },
};

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-lg font-semibold text-gray-900">{value ?? 0}</div>
    </div>
  );
}

function fmt(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}
