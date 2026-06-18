import { useState, useEffect, useCallback, useRef, Suspense, lazy, createElement } from 'react';
import { useAuth } from '../auth/AuthGate';
import ScheduleEditor from './ScheduleEditor';
import Stepper from './Stepper';
import useDocsUrl from '../hooks/useDocsUrl';
import { formatDurationSeconds as formatDurationHMS } from '../utils/formatters';

// Crawler wizard components and their display metadata are auto-discovered by naming convention:
//   tools/crawlers/{type}/ConfigWizard.jsx  — the wizard form (lazy-loaded)
//   tools/crawlers/{type}/CrawlerMeta.js    — { id, name, description } for the type picker
// Adding a new crawler type never requires editing this file.
const _wizardModules = import.meta.glob('../../../../tools/crawlers/*/ConfigWizard.jsx');
function getCrawlerWizard(crawlerType) {
  const loader = _wizardModules[`../../../../tools/crawlers/${crawlerType}/ConfigWizard.jsx`];
  return loader ? lazy(loader) : null;
}

const _crawlerMetaModules = import.meta.glob('../../../../tools/crawlers/*/CrawlerMeta.js', { eager: true });
const _discoveredCrawlerTypes = Object.values(_crawlerMetaModules).map(m => ({ ...m.default, available: true }));

// Optional per-crawler summary panel shown on the configured-crawlers card.
// Eager (not lazy like the wizard) — every visible card needs it immediately,
// not on demand. Crawlers without a Summary.jsx just show the generic
// schedule/last-run footer with no extra panel.
const _summaryModules = import.meta.glob('../../../../tools/crawlers/*/Summary.jsx', { eager: true });
function getCrawlerSummary(crawlerType) {
  return _summaryModules[`../../../../tools/crawlers/${crawlerType}/Summary.jsx`]?.default || null;
}

// ─── Crawler type catalog ─────────────────────────────────────────────────────
// `demo` keeps its wizard inline in this file (no persisted config — it's a
// one-shot immediate job). File-based crawlers under tools/crawlers/*/CrawlerMeta.js
// are appended automatically.
const CRAWLER_TYPES = [
  {
    id: 'demo',
    name: 'Demo Data',
    description: 'Load synthetic data to explore the platform (~30 seconds)',
    available: true, immediate: true,
  },
  ..._discoveredCrawlerTypes,
  {
    id: 'custom',
    name: 'Custom Connector',
    description: 'Build your own crawler using the Ingest API — register an API key, download the OpenAPI spec, start pushing data',
    available: true,
  },
];

// ─── Step 1: Select Type ──────────────────────────────────────────────────────
function SelectType({ onSelect, onCancel }) {
  return (
    <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg dark:bg-gray-800 dark:border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold dark:text-white">Add Crawler — Select Type</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-700 text-sm dark:text-gray-400 dark:hover:text-gray-200">Cancel</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {CRAWLER_TYPES.map(t => (
          <button
            key={t.id}
            onClick={() => t.available && onSelect(t.id)}
            disabled={!t.available}
            className={`flex flex-col items-start p-4 rounded-lg border-2 text-left transition-all ${
              t.available
                ? 'border-gray-200 hover:border-blue-400 hover:shadow-md cursor-pointer dark:border-gray-700 dark:hover:border-blue-500'
                : 'border-gray-100 opacity-50 cursor-not-allowed dark:border-gray-700'
            }`}
          >
            <span className="font-semibold text-gray-900 dark:text-white">{t.name}</span>
            <span className="text-sm text-gray-500 mt-1 dark:text-gray-400">{t.description}</span>
            {t.comingSoon && (
              <span className="mt-2 px-2 py-0.5 bg-gray-100 text-gray-500 text-xs rounded-full dark:bg-gray-700 dark:text-gray-400">Coming soon</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Configured Crawler Card (display-only — Configure opens wizard in edit mode) ──
function CrawlerConfigCard({ config, onRunNow, onEdit, onRemove, onExport, onForceStop, runningJob }) {
  const cfg = config.config || {};

  // Sync mode is now chosen per-run: two buttons (Run Delta / Run Full)
  // on this card, or per-schedule via the Mode dropdown on each schedule
  // entry. The old `nextRunMode` column on CrawlerConfigs still works as
  // a server-side scheduler fallback but has no UI surface anymore.

  const isRunning = runningJob && ['queued', 'running'].includes(runningJob.status);

  // Build schedule list (supports both `schedules` array and legacy `schedule` single)
  const scheduleList = cfg.schedules?.length ? cfg.schedules : (cfg.schedule ? [cfg.schedule] : []);
  const formatSched = (s) => {
    let label = s.frequency;
    if (s.frequency !== 'hourly') {
      label += ` at ${String(s.hour ?? 0).padStart(2,'0')}:${String(s.minute ?? 0).padStart(2,'0')} UTC`;
    } else {
      label += ` :${String(s.minute ?? 0).padStart(2,'0')}`;
    }
    if (s.frequency === 'weekly') {
      label += ` on ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][s.day ?? 0]}`;
    }
    label += s.syncMode === 'full' ? ' · full' : ' · delta';
    return label;
  };

  return (
    <div className="p-4 bg-white border border-gray-200 rounded-lg dark:bg-gray-800 dark:border-gray-700">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="font-semibold text-gray-900 dark:text-white">{config.displayName}</h4>
          <span className="text-xs text-gray-500 dark:text-gray-400">{config.crawlerType}</span>
        </div>
        <div className="flex gap-1">
          {isRunning ? (
            <button
              onClick={() => onForceStop(runningJob.id)}
              className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
            >
              Force Stop
            </button>
          ) : (
            <>
              <button
                onClick={() => onRunNow(config.id, 'delta')}
                title="Queue a delta run — fetches only what changed since the last successful sync."
                className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Run Delta
              </button>
              <button
                onClick={() => onRunNow(config.id, 'full')}
                title="Queue a full run — re-fetches everything, resets delta tokens."
                className="px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700"
              >
                Run Full
              </button>
            </>
          )}
          <button onClick={() => onEdit(config)}
            className="px-3 py-1 text-xs bg-gray-100 rounded hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
            Configure
          </button>
          <button onClick={() => onExport(config)}
            title="Download this crawler's configuration as JSON (client secret is stripped)"
            className="px-3 py-1 text-xs bg-gray-100 rounded hover:bg-gray-200">
            Export
          </button>
          <button onClick={() => onRemove(config.id)}
            className="px-3 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40">
            Remove
          </button>
        </div>
      </div>

      {(() => {
        const Summary = getCrawlerSummary(config.crawlerType);
        return Summary ? createElement(Summary, { cfg, config }) : null;
      })()}

      {/* Schedules */}
      {scheduleList.length > 0 && (
        <div className="text-xs text-gray-500 mt-2 space-y-1 dark:text-gray-400">
          {scheduleList.map((s, i) => (
            <div key={i}>
              <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded dark:bg-blue-900/30 dark:text-blue-300">
                Schedule: {formatSched(s)}
              </span>
            </div>
          ))}
        </div>
      )}

      {config.lastRunAt && (
        <div className="text-xs text-gray-500 mt-2 dark:text-gray-400">
          Last run: {new Date(config.lastRunAt).toLocaleString()}
          {config.lastRunStatus && (
            <span className={`ml-2 px-1.5 py-0.5 rounded-full ${
              config.lastRunStatus === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
            }`}>{config.lastRunStatus}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Job Progress Card ────────────────────────────────────────────────────────
function JobProgress({ job, configLabel, onNavigateToMatrix, onDismiss }) {
  // Store current time in state so the "last update Xs ago" line stays accurate
  // without calling impure Date.now() during render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!job || ['completed','failed','cancelled'].includes(job.status)) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [job?.status]);

  if (!job) return null;
  const progress = job.progress ? (typeof job.progress === 'string' ? JSON.parse(job.progress) : job.progress) : {};
  const pct = progress.pct || 0;
  const step = progress.step || 'Waiting...';
  const detail = progress.detail || '';
  const updatedAt = progress.updatedAt ? new Date(progress.updatedAt) : null;
  const secondsSince = updatedAt ? Math.max(0, Math.round((now - updatedAt.getTime()) / 1000)) : null;

  // Header label on every card so two running crawlers are distinguishable
  // at a glance. Falls back to the bare job type string if the config name
  // isn't known (manual jobs without a source config, demo jobs).
  const header = configLabel || job.jobType;

  if (job.status === 'completed') {
    return (
      <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg dark:bg-green-900/20 dark:border-green-700">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-green-700 uppercase tracking-wide mb-0.5 dark:text-green-400">{header}</div>
            <span className="font-semibold text-green-800 dark:text-green-300">Data loaded successfully!</span>
            <p className="text-sm text-green-600 mt-1 dark:text-green-400">Your identity data is ready to explore.</p>
          </div>
          <div className="flex gap-2">
            {onNavigateToMatrix && (
              <button onClick={onNavigateToMatrix} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700">Open Matrix</button>
            )}
            {onDismiss && <button onClick={onDismiss} className="text-green-600 hover:text-green-800 text-sm dark:text-green-400 dark:hover:text-green-200">Dismiss</button>}
          </div>
        </div>
      </div>
    );
  }
  if (job.status === 'failed') {
    return (
      <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg dark:bg-red-900/20 dark:border-red-700">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-red-700 uppercase tracking-wide mb-0.5 dark:text-red-400">{header}</div>
            <span className="font-semibold text-red-800 dark:text-red-300">Job failed</span>
            <p className="text-sm text-red-600 mt-1 dark:text-red-400">{job.errorMessage || 'Unknown error'}</p>
          </div>
          {onDismiss && <button onClick={onDismiss} className="text-red-500 hover:text-red-700 text-sm dark:text-red-400 dark:hover:text-red-200">Dismiss</button>}
        </div>
      </div>
    );
  }
  // "Stale" once we've gone >60s without a fresh update — useful indicator that
  // something might be hung (or that the crawler is in an unreported tight loop).
  const staleness = secondsSince == null ? null
    : secondsSince < 10 ? 'fresh'
    : secondsSince < 60 ? 'normal'
    : 'stale';
  const stalenessColor = staleness === 'stale' ? 'text-amber-700' : 'text-blue-700';

  // Queued jobs get a softer treatment: amber card, no percent, no progress
  // bar — the worker still has to pick this one up, and showing 0% with a
  // flatlined bar implies "stuck" when it's just "waiting in line".
  if (job.status === 'queued') {
    return (
      <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg dark:bg-amber-900/20 dark:border-amber-700">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-amber-800 uppercase tracking-wide mb-0.5 dark:text-amber-300">{header}</div>
            <span className="font-semibold text-amber-900 dark:text-amber-300">Queued</span>
            <p className="text-sm text-amber-700 mt-1 dark:text-amber-400">Waiting for the worker — will start when the current run finishes.</p>
          </div>
          {onDismiss && <button onClick={onDismiss} className="text-amber-700 hover:text-amber-900 text-sm dark:text-amber-400 dark:hover:text-amber-200">Dismiss</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg dark:bg-blue-900/20 dark:border-blue-700">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-medium text-blue-700 uppercase tracking-wide dark:text-blue-400">{header}</div>
        {onDismiss && <button onClick={onDismiss} className="text-blue-500 hover:text-blue-700 text-xs dark:text-blue-400 dark:hover:text-blue-200">Dismiss</button>}
      </div>
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold text-blue-800 dark:text-blue-300">{step}</span>
        <span className="text-sm text-blue-600 dark:text-blue-400">{pct}%</span>
      </div>
      <div className="w-full bg-blue-200 rounded-full h-2.5 dark:bg-blue-900/40">
        <div className="bg-blue-600 h-2.5 rounded-full transition-all duration-500" style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      {(detail || secondsSince != null) && (
        <div className="flex items-center justify-between mt-2 text-xs">
          <span className="text-blue-700 truncate font-mono dark:text-blue-400">{detail || ''}</span>
          {secondsSince != null && (
            <span className={`ml-2 flex-shrink-0 ${stalenessColor}`} title={updatedAt?.toLocaleString()}>
              {secondsSince === 0 ? 'just now' : `${secondsSince}s ago`}
              {staleness === 'stale' && ' · no updates'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Job Phases Modal ─────────────────────────────────────────────────────────
// Opens when the operator clicks "Details" on a completed/failed job. Shows
// the per-phase breakdown written by the crawler at end-of-run: status,
// duration, and error text per phase. Falls back to the raw errorMessage
// text when a legacy job pre-dates the phases column.
function JobPhasesModal({ job, onClose }) {
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
  }, [job?.id, activeTab, isRunning, authFetch]);

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
    return <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300" />;
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
          ? 'border-blue-600 text-blue-700 font-medium'
          : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >{label}</button>
  );

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <span>Job {job.id} — {job.jobType}</span>
              {job.config?._syncMode === 'full' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800" title="Full sync: re-fetches everything.">full</span>
              )}
              {job.config?._syncMode === 'delta' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700" title="Delta sync: fetches only what changed.">delta</span>
              )}
            </h2>
            <div className="text-xs text-gray-500 mt-0.5">
              {new Date(job.createdAt).toLocaleString()} ·
              {' '}<span className={job.status === 'failed' ? 'text-red-600' : job.status === 'completed' ? 'text-green-600' : 'text-gray-600'}>{job.status}</span>
              {phases.length > 0 && <> · {okCount} ok, {failedCount} failed</>}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 pt-3 border-b border-gray-200 flex items-center gap-1">
          {tabBtn('phases', 'Phases')}
          {tabBtn('trace', 'Trace')}
          {activeTab === 'trace' && trace.exists && (
            <span className="ml-auto text-xs text-gray-500">
              {fmtBytes(trace.totalLength)}{isRunning && <span className="ml-2 text-blue-600">● live</span>}
            </span>
          )}
        </div>
        <div className="overflow-auto p-6 flex-1">
          {activeTab === 'phases' && (phases.length === 0 ? (
            <div>
              <p className="text-sm text-gray-600 mb-2">No per-phase breakdown available for this job.</p>
              {job.errorMessage && (
                <pre className="bg-red-50 border border-red-200 text-red-800 text-xs p-3 rounded whitespace-pre-wrap break-words">{job.errorMessage}</pre>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-2 font-medium w-6"></th>
                  <th className="text-left p-2 font-medium">Phase</th>
                  <th className="text-right p-2 font-medium">Duration</th>
                  <th className="text-left p-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {phases.map((p, i) => (
                  <tr key={i} className={p.status === 'failed' ? 'bg-red-50' : ''}>
                    <td className="p-2 align-top">{dot(p.status)}</td>
                    <td className="p-2 font-mono text-xs align-top">{p.name}</td>
                    <td className="p-2 text-right text-gray-600 align-top">{fmtMs(p.durationMs)}</td>
                    <td className="p-2 align-top">
                      {p.error ? (
                        <span className="text-red-700 text-xs break-words">{p.error}</span>
                      ) : p.records ? (
                        <span className="text-gray-600 text-xs font-mono">
                          {Object.entries(p.records).map(([k, v]) => `${k}=${v}`).join(' · ')}
                        </span>
                      ) : (
                        <span className="text-gray-500 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
          {activeTab === 'trace' && (
            !trace.exists ? (
              <div className="text-sm text-gray-500">
                {isRunning
                  ? 'Waiting for the worker to produce output…'
                  : 'No trace captured for this job. Traces are written by runs after this feature shipped — older jobs have phases only.'}
              </div>
            ) : (
              <pre
                ref={traceRef}
                className="bg-gray-900 text-gray-100 text-xs font-mono p-3 rounded overflow-auto whitespace-pre-wrap break-words max-h-[60vh]"
              >{trace.text || '(empty)'}</pre>
            )
          )}
          {activeTab === 'trace' && traceError && (
            <div className="mt-2 text-xs text-red-600">Failed to refresh trace: {traceError}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Recent Jobs Table ────────────────────────────────────────────────────────
function RecentJobs({ jobs, onForceStop }) {
  const [detailsJob, setDetailsJob] = useState(null);
  if (!jobs || jobs.length === 0) return null;
  const statusColors = {
    queued: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
    running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    cancelled: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  };
  return (
    <div className="mb-6">
      <h3 className="text-lg font-semibold mb-3 dark:text-white">Recent Jobs</h3>
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className="text-left p-3 font-medium dark:text-gray-300">Type</th>
              <th className="text-left p-3 font-medium dark:text-gray-300">Mode</th>
              <th className="text-left p-3 font-medium dark:text-gray-300">Status</th>
              <th className="text-left p-3 font-medium dark:text-gray-300">Created</th>
              <th className="text-left p-3 font-medium dark:text-gray-300">Duration</th>
              <th className="text-left p-3 font-medium dark:text-gray-300">Error</th>
              <th className="text-left p-3 font-medium w-16 dark:text-gray-300"></th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-gray-700">
            {jobs.map(j => {
              const duration = j.startedAt && j.completedAt
                ? formatDurationHMS(Math.round((new Date(j.completedAt) - new Date(j.startedAt)) / 1000))
                : j.startedAt ? 'running...' : '—';
              const isTerminal = j.status !== 'running' && j.status !== 'queued';
              // Always show Details — the modal's Trace tab is useful even
              // for queued/running jobs (live tail), and for completed jobs
              // with neither phases nor errorMessage the modal still shows
              // a sensible empty state.
              const hasDetails = true;
              // Effective syncMode: set by the scheduler on scheduled runs
              // (`config._syncMode`) and by the manual Run-Now path. Older
              // jobs won't have it — show '—'.
              const jobSyncMode = j.config?._syncMode;
              const modeBadge = jobSyncMode === 'full'
                ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" title="Full: re-fetches everything from the source, ignores any stored delta tokens.">full</span>
                : jobSyncMode === 'delta'
                  ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300" title="Delta: fetches only what changed since the last successful run.">delta</span>
                  : <span className="text-gray-600 text-xs">—</span>;
              return (
                <tr key={j.id}>
                  <td className="p-3 font-medium dark:text-gray-200">{j.jobType}</td>
                  <td className="p-3">{modeBadge}</td>
                  <td className="p-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[j.status] || ''}`}>{j.status}</span></td>
                  <td className="p-3 text-gray-500 dark:text-gray-400">{new Date(j.createdAt).toLocaleString()}</td>
                  <td className="p-3 text-gray-500 dark:text-gray-400">{duration}</td>
                  <td className="p-3 text-red-500 text-xs truncate max-w-64 dark:text-red-400">
                    {isTerminal ? (j.errorMessage || '—') : (
                      <button onClick={() => onForceStop?.(j.id)} className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40">Force Stop</button>
                    )}
                  </td>
                  <td className="p-3">
                    {hasDetails && (
                      <button
                        onClick={() => setDetailsJob(j)}
                        className="px-2 py-0.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                      >Details</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {detailsJob && <JobPhasesModal job={detailsJob} onClose={() => setDetailsJob(null)} />}
    </div>
  );
}

// ─── Custom Connectors Table (API key crawlers) ──────────────────────────────
function ExternalCrawlers({ crawlers, onToggle, onResetKey, onRemove, newKey, onDismissKey, onCopy, expandedAudit, auditData, onToggleAudit }) {
  const visible = crawlers.filter(c => c.displayName !== 'Built-in Worker');
  if (visible.length === 0) return null;

  const formatDate = (d) => d ? new Date(d).toLocaleString() : '—';

  return (
    <div className="mb-6">
      <h3 className="text-lg font-semibold mb-3 dark:text-white">Custom Connectors</h3>

      {newKey && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg dark:bg-green-900/20 dark:border-green-700">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-green-800 dark:text-green-300">API Key Generated</span>
            <button onClick={onDismissKey} className="text-green-600 hover:text-green-800 text-sm dark:text-green-400 dark:hover:text-green-200">Dismiss</button>
          </div>
          <p className="text-sm text-green-700 mb-2 dark:text-green-400">Store this key securely. It will not be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 p-2 bg-white border border-gray-200 rounded font-mono text-sm break-all dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200">{newKey}</code>
            <button onClick={() => onCopy(newKey)} className="px-3 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700">Copy</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className="text-left p-3 font-medium dark:text-gray-300">Name</th>
              <th className="text-left p-3 font-medium dark:text-gray-300">Key Prefix</th>
              <th className="text-left p-3 font-medium dark:text-gray-300">Status</th>
              <th className="text-left p-3 font-medium dark:text-gray-300">Last Used</th>
              <th className="text-right p-3 font-medium dark:text-gray-300">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-gray-700">
            {visible.map(c => (
              <tr key={c.id}>
                <td className="p-3">
                  <div className="font-medium dark:text-gray-200">{c.displayName}</div>
                  {c.description && <div className="text-xs text-gray-500 dark:text-gray-400">{c.description}</div>}
                </td>
                <td className="p-3 font-mono text-xs dark:text-gray-300">{c.apiKeyPrefix}...</td>
                <td className="p-3">
                  <button onClick={() => onToggle(c)}
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${c.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'}`}>
                    {c.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </td>
                <td className="p-3 text-gray-500 dark:text-gray-400">{formatDate(c.lastUsedAt)}</td>
                <td className="p-3 text-right">
                  <div className="flex gap-1 justify-end">
                    <button onClick={() => onToggleAudit(c.id)} className="px-2 py-1 text-xs bg-gray-100 rounded hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
                      {expandedAudit === c.id ? 'Hide' : 'Log'}
                    </button>
                    <button onClick={() => onResetKey(c)} className="px-2 py-1 text-xs bg-amber-100 text-amber-800 rounded hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50">Reset Key</button>
                    <button onClick={() => onRemove(c)} className="px-2 py-1 text-xs bg-red-100 text-red-800 rounded hover:bg-red-200 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40">Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Getting Started Card ─────────────────────────────────────────────────────
function GettingStarted({ onAddCrawler }) {
  return (
    <div className="mb-8 p-6 bg-gradient-to-br from-emerald-50 to-teal-50 border border-emerald-200 rounded-xl text-center dark:from-emerald-900/20 dark:to-teal-900/20 dark:border-emerald-700">
      <h2 className="text-xl font-bold text-emerald-900 mb-2 dark:text-emerald-300">Welcome to Identity Atlas</h2>
      <p className="text-emerald-700 mb-4 dark:text-emerald-400">No identity data loaded yet. Add a crawler to get started.</p>
      <button onClick={onAddCrawler} className="px-6 py-3 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium">
        Add Crawler
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Custom Connector Wizard
// ═══════════════════════════════════════════════════════════════════════════════

function CustomConnectorWizard({ onComplete, onCancel, authFetch }) {
  const docsLink = useDocsUrl();
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [registering, setRegistering] = useState(false);
  const [apiKey, setApiKey] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null); // track which field was copied

  const apiBaseUrl = `${window.location.origin}/api`;

  const handleRegister = async () => {
    if (!name.trim()) return;
    setRegistering(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: name.trim(),
          description: description.trim() || null,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setApiKey(data.apiKey);
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setRegistering(false);
    }
  };

  const copyToClipboard = (text, field) => {
    navigator.clipboard.writeText(text);
    setCopied(field);
    setTimeout(() => setCopied(null), 2000);
  };

  const curlExample = `curl -X POST ${apiBaseUrl}/ingest/systems \\
  -H "Authorization: Bearer ${apiKey || '<your-api-key>'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "syncMode": "delta",
    "records": [{
      "displayName": "My System",
      "systemType": "Custom",
      "enabled": true,
      "syncEnabled": true
    }]
  }'`;

  const pythonExample = `import requests

API = "${apiBaseUrl}"
KEY = "${apiKey || '<your-api-key>'}"
headers = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

# 1. Register a system
r = requests.post(f"{API}/ingest/systems", headers=headers, json={
    "syncMode": "delta",
    "records": [{"displayName": "My System", "systemType": "Custom",
                 "enabled": True, "syncEnabled": True}]
})
system_id = r.json()["systemIds"][0]

# 2. Push users
requests.post(f"{API}/ingest/principals", headers=headers, json={
    "systemId": system_id, "syncMode": "delta",
    "records": [{"externalId": "user-1", "displayName": "Alice",
                 "principalType": "User", "accountEnabled": True}]
})

# 3. Push resources
requests.post(f"{API}/ingest/resources", headers=headers, json={
    "systemId": system_id, "syncMode": "delta",
    "records": [{"externalId": "role-1", "displayName": "Admin Role",
                 "resourceType": "Role", "enabled": True}]
})

# 4. Push assignments (who has access to what)
requests.post(f"{API}/ingest/resource-assignments", headers=headers, json={
    "systemId": system_id, "syncMode": "delta",
    "records": [{"principalExternalId": "user-1",
                 "resourceExternalId": "role-1",
                 "assignmentType": "Direct"}]
})`;

  const powershellExample = `$api = "${apiBaseUrl}"
$key = "${apiKey || '<your-api-key>'}"
$headers = @{ Authorization = "Bearer $key"; 'Content-Type' = 'application/json' }

# 1. Register a system
$r = Invoke-RestMethod -Uri "$api/ingest/systems" -Method Post -Headers $headers -Body (@{
    syncMode = 'delta'; records = @(@{
        displayName = 'My System'; systemType = 'Custom'; enabled = $true; syncEnabled = $true
    })
} | ConvertTo-Json -Depth 5)
$systemId = $r.systemIds[0]

# 2. Push users
Invoke-RestMethod -Uri "$api/ingest/principals" -Method Post -Headers $headers -Body (@{
    systemId = $systemId; syncMode = 'delta'; records = @(@{
        externalId = 'user-1'; displayName = 'Alice'; principalType = 'User'; accountEnabled = $true
    })
} | ConvertTo-Json -Depth 5)`;

  const connectorSteps = [
    { n: 1, label: 'Register' },
    { n: 2, label: 'API Key' },
    { n: 3, label: 'Getting started' },
  ];

  return (
    <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg dark:bg-gray-800 dark:border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold dark:text-white">Custom Connector</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-700 text-sm dark:text-gray-400 dark:hover:text-gray-200">Cancel</button>
      </div>

      <div className="mb-5"><Stepper steps={connectorSteps} current={step} /></div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm dark:bg-red-900/20 dark:border-red-700 dark:text-red-300">{error}</div>
      )}

      {/* Step 1: Name + register */}
      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Register a custom connector to push data from any system into Identity Atlas using the Ingest API.
            You'll get an API key to authenticate your requests.
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">Connector name *</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. SAP HR Export, ServiceNow CMDB, Okta Sync"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">Description (optional)</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="What system does this connector pull data from?"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onCancel} className="px-4 py-2 bg-gray-100 rounded text-sm dark:bg-gray-700 dark:text-gray-300">Cancel</button>
            <button onClick={handleRegister} disabled={!name.trim() || registering}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
              {registering ? 'Registering...' : 'Register Connector'}
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Show API key (one-time) */}
      {step === 2 && apiKey && (
        <div className="space-y-4">
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg dark:bg-amber-900/20 dark:border-amber-700">
            <p className="text-sm font-medium text-amber-800 mb-2 dark:text-amber-300">
              Save this API key now — it will not be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded text-sm font-mono break-all dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200">{apiKey}</code>
              <button onClick={() => copyToClipboard(apiKey, 'key')}
                className="px-3 py-2 bg-amber-600 text-white rounded text-sm hover:bg-amber-700 whitespace-nowrap">
                {copied === 'key' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">API Base URL</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded text-sm font-mono dark:bg-gray-700/50 dark:border-gray-600 dark:text-gray-200">{apiBaseUrl}</code>
              <button onClick={() => copyToClipboard(apiBaseUrl, 'url')}
                className="px-3 py-2 bg-gray-200 rounded text-sm hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
                {copied === 'url' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
          <div className="flex justify-end">
            <button onClick={() => setStep(3)}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
              Next: Getting Started
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Docs, spec download, code examples */}
      {step === 3 && (
        <div className="space-y-5">
          {/* Quick links */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <a href={`${apiBaseUrl}/docs`} target="_blank" rel="noopener noreferrer"
              className="flex flex-col items-center p-4 border-2 rounded-lg hover:border-blue-400 hover:shadow-md transition-all text-center dark:border-gray-700 dark:hover:border-blue-500">
              <span className="text-2xl mb-1">📖</span>
              <span className="font-medium text-sm dark:text-gray-200">Swagger UI</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">Interactive API explorer</span>
            </a>
            <a href={`${apiBaseUrl}/openapi.json`} download="identity-atlas-openapi.json"
              className="flex flex-col items-center p-4 border-2 rounded-lg hover:border-blue-400 hover:shadow-md transition-all text-center dark:border-gray-700 dark:hover:border-blue-500">
              <span className="text-2xl mb-1">📄</span>
              <span className="font-medium text-sm dark:text-gray-200">Download OpenAPI Spec</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">JSON format</span>
            </a>
            <a href={docsLink('/architecture/csv-import-schema/')} target="_blank" rel="noopener noreferrer"
              className="flex flex-col items-center p-4 border-2 rounded-lg hover:border-blue-400 hover:shadow-md transition-all text-center dark:border-gray-700 dark:hover:border-blue-500">
              <span className="text-2xl mb-1">📋</span>
              <span className="font-medium text-sm dark:text-gray-200">CSV Schema Reference</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">Field definitions for all entity types</span>
            </a>
          </div>

          {/* Code examples */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-2 dark:text-gray-200">Quick Start Examples</h4>
            <ExampleTabs examples={[
              { label: 'curl', code: curlExample },
              { label: 'Python', code: pythonExample },
              { label: 'PowerShell', code: powershellExample },
            ]} onCopy={copyToClipboard} copied={copied} />
          </div>

          {/* Ingest flow explanation */}
          <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 space-y-2 dark:bg-gray-700/50 dark:border-gray-600 dark:text-gray-300">
            <p className="font-medium dark:text-gray-200">How the Ingest API works:</p>
            <ol className="list-decimal list-inside space-y-1 text-gray-600 dark:text-gray-400">
              <li><strong>Systems</strong> — register your source system (once)</li>
              <li><strong>Principals</strong> — push user accounts (with systemId from step 1)</li>
              <li><strong>Resources</strong> — push groups, roles, apps, or any permission-granting entity</li>
              <li><strong>Resource Assignments</strong> — push who has access to what</li>
              <li><strong>Resource Relationships</strong> — push role-to-resource nesting (optional)</li>
              <li><strong>Identities + Identity Members</strong> — push cross-system account correlation (optional)</li>
              <li><strong>Refresh Views</strong> — call <code className="dark:text-gray-300">POST /ingest/refresh-views</code> after a full sync to update the matrix</li>
            </ol>
            <p className="mt-2">
              Use <code className="dark:text-gray-300">syncMode: "full"</code> to replace all data for a system, or <code className="dark:text-gray-300">"delta"</code> to upsert incrementally.
            </p>
          </div>

          <div className="flex justify-end">
            <button onClick={onComplete}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Tab switcher for code examples
function ExampleTabs({ examples, onCopy, copied }) {
  const [active, setActive] = useState(0);
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden dark:border-gray-700">
      <div className="flex border-b bg-gray-50 dark:bg-gray-700/50 dark:border-gray-700">
        {examples.map((ex, i) => (
          <button key={ex.label} onClick={() => setActive(i)}
            className={`px-4 py-2 text-sm font-medium ${
              i === active ? 'bg-white border-b-2 border-blue-500 text-blue-700 dark:bg-gray-800 dark:text-blue-400' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }`}>
            {ex.label}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={() => onCopy(examples[active].code, `example-${active}`)}
          className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 self-center mr-2 dark:text-gray-400 dark:hover:text-gray-200">
          {copied === `example-${active}` ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="p-4 text-xs font-mono overflow-x-auto bg-gray-900 text-gray-100 max-h-80">
        {examples[active].code}
      </pre>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main CrawlersPage
// ═══════════════════════════════════════════════════════════════════════════════

export default function CrawlersPage({ onNavigate }) {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Data
  const [crawlers, setCrawlers] = useState([]);
  const [configs, setConfigs] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [status, setStatus] = useState(null);
  // We track MULTIPLE concurrent jobs now. Each rendering a progress card.
  // A job lands here when:
  //   - submitJob returns an entry (immediate UI feedback for the user's click)
  //   - fetchJobs discovers a queued/running job we weren't tracking yet
  // A job stays here after transitioning to completed/failed (so the user
  // sees the final state) until they click Dismiss. The poll updates the
  // status of tracked jobs in place.
  const [activeJobs, setActiveJobs] = useState([]);
  const prevActiveJobsRef = useRef([]);
  const pollRef = useRef(null);

  // Wizard state — 'select' (type picker), 'crawler-wizard' (generic), 'custom-wizard'
  const [wizardStep, setWizardStep] = useState(null);
  // For 'crawler-wizard': which crawler type's wizard to render
  const [wizardCrawlerType, setWizardCrawlerType] = useState(null);
  // When editing an existing config, holds its full data + id; null otherwise
  const [editingConfig, setEditingConfig] = useState(null);

  // External crawler state
  const [newKey, setNewKey] = useState(null);
  const [expandedAudit, setExpandedAudit] = useState(null);
  const [auditData, setAuditData] = useState({ data: [], total: 0 });

  // ── Fetchers ──────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try { const r = await authFetch('/api/admin/status'); if (r.ok) setStatus(await r.json()); } catch {}
  }, [authFetch]);

  const fetchConfigs = useCallback(async () => {
    try { const r = await authFetch('/api/admin/crawler-configs'); if (r.ok) setConfigs(await r.json()); } catch {}
  }, [authFetch]);

  const fetchCrawlers = useCallback(async () => {
    try {
      const r = await authFetch('/api/admin/crawlers');
      if (r.ok) setCrawlers(await r.json());
    } catch {}
  }, [authFetch]);

  const fetchJobs = useCallback(async () => {
    try {
      const r = await authFetch('/api/admin/crawler-jobs?limit=10');
      if (!r.ok) return;
      const data = await r.json();
      if (!Array.isArray(data)) return;
      setJobs(data);
      // Rebuild activeJobs:
      //   - keep each currently-tracked job, but refresh its status from
      //     the server response (so running → completed transitions show)
      //   - add any queued/running job we aren't tracking yet
      //   - completed/failed jobs we AREN'T tracking don't get re-added
      //     (users dismiss them; we respect that by not re-discovering)
      setActiveJobs(prev => {
        const byId = Object.fromEntries(data.map(j => [j.id, j]));
        const carried = prev.map(pj => byId[pj.id] ?? pj);
        for (const j of data) {
          if (['queued', 'running'].includes(j.status) && !carried.find(k => k.id === j.id)) {
            carried.push(j);
          }
        }
        return carried;
      });
    } catch {}
  }, [authFetch]);

  // When any tracked job transitions from active → terminal, refresh the
  // dashboard stats (config counts, last-run timestamps).
  useEffect(() => {
    const prev = prevActiveJobsRef.current;
    const justFinished = prev.some(pj =>
      ['queued', 'running'].includes(pj.status) &&
      activeJobs.find(aj => aj.id === pj.id && ['completed', 'failed', 'cancelled'].includes(aj.status))
    );
    if (justFinished) {
      fetchStatus();
      fetchConfigs();
    }
    prevActiveJobsRef.current = activeJobs;
  }, [activeJobs, fetchStatus, fetchConfigs]);

  useEffect(() => {
    Promise.all([fetchCrawlers(), fetchConfigs(), fetchStatus(), fetchJobs()])
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // Keep polling as long as ANY tracked job is still active. As soon as
    // they all hit a terminal state (or the user dismisses them), we stop.
    const anyActive = activeJobs.some(j => ['queued', 'running'].includes(j.status));
    if (anyActive) {
      pollRef.current = setInterval(fetchJobs, 3000);
      return () => clearInterval(pollRef.current);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
    }
  }, [activeJobs, fetchJobs]);

  // ── Wizard actions ────────────────────────────────────────────

  const handleSelectType = (type) => {
    if (type === 'demo') {
      submitJob('demo');
      setWizardStep(null);
    } else if (getCrawlerWizard(type)) {
      setEditingConfig(null);
      setWizardCrawlerType(type); setWizardStep('crawler-wizard');
    } else if (type === 'custom') {
      setEditingConfig(null);
      setWizardStep('custom-wizard');
    }
  };

  // Open the wizard in edit mode for an existing config
  const handleEditConfig = (config) => {
    // The config from the API has secrets masked — wizard handles this
    setEditingConfig({
      id: config.id,
      displayName: config.displayName,
      ...(config.config || {}),
    });
    setWizardCrawlerType(config.crawlerType);
    setWizardStep('crawler-wizard');
  };

  // ── Job actions ───────────────────────────────────────────────

  const submitJob = async (jobType, config = null, configId = null, syncMode = null) => {
    try {
      const body = { jobType };
      if (config) body.config = config;
      if (configId) body.configId = configId;
      if (syncMode) body.syncMode = syncMode;
      const r = await authFetch('/api/admin/crawler-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error || `HTTP ${r.status}`); }
      const job = await r.json();
      // Add to the tracked set (replacing if the same id somehow re-appears).
      // The poll will overwrite with the canonical server copy on the next
      // tick; this just gives the user an immediate card to watch.
      setActiveJobs(prev => [...prev.filter(j => j.id !== job.id), job]);
      fetchJobs();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRunNow = (configId, syncMode = null) => {
    const cfg = configs.find(c => c.id === configId);
    if (cfg) submitJob(cfg.crawlerType, null, configId, syncMode);
  };

  const handleForceStop = async (jobId) => {
    if (!confirm('Force-stop this running job? Any partially imported data will remain.')) return;
    try {
      await authFetch(`/api/admin/crawler-jobs/${jobId}/force-stop`, { method: 'POST' });
      fetchJobs();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemoveConfig = async (configId) => {
    if (!confirm('Remove this crawler configuration?')) return;
    try {
      await authFetch(`/api/admin/crawler-configs/${configId}`, { method: 'DELETE' });
      fetchConfigs();
    } catch (err) {
      setError(err.message);
    }
  };

  // ── Export / Import ───────────────────────────────────────────

  // The server already masks clientSecret on the config payload, but we also
  // empty it here and drop the tenant-specific validation blob so the
  // exported file is obviously safe to commit to a repo / share in Slack.
  const handleExportConfig = (config) => {
    const cfg = { ...(config.config || {}) };
    cfg.clientSecret = '';
    delete cfg.validation;
    const payload = {
      _schemaVersion: 1,
      _exportedAt: new Date().toISOString(),
      displayName: config.displayName,
      crawlerType: config.crawlerType,
      config: cfg,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const slug = (config.displayName || 'crawler').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crawler-${slug || 'export'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const importFileRef = useRef(null);
  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!imported.crawlerType || !imported.config) {
        throw new Error('Invalid export file (missing crawlerType or config)');
      }
      if (!getCrawlerWizard(imported.crawlerType)) {
        throw new Error(`Unsupported crawlerType: ${imported.crawlerType}`);
      }
      // No id on editingConfig → wizard treats this as a new crawler;
      // the user must re-enter secrets on step 2.
      setEditingConfig({
        displayName: imported.displayName || '',
        ...(imported.config || {}),
      });
      setWizardCrawlerType(imported.crawlerType);
      setWizardStep('crawler-wizard');
    } catch (err) {
      setError(`Import failed: ${err.message}`);
    } finally {
      // Reset so re-selecting the same file still fires onChange.
      e.target.value = '';
    }
  };

  // ── External crawler actions ──────────────────────────────────

  const handleToggleEnabled = async (c) => {
    try {
      await authFetch(`/api/admin/crawlers/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !c.enabled }) });
      fetchCrawlers();
    } catch (err) { setError(err.message); }
  };

  const handleResetKey = async (c) => {
    if (!confirm(`Reset API key for "${c.displayName}"?`)) return;
    try {
      const r = await authFetch(`/api/admin/crawlers/${c.id}/reset`, { method: 'POST' });
      if (r.ok) { const d = await r.json(); setNewKey(d.apiKey); fetchCrawlers(); }
    } catch (err) { setError(err.message); }
  };

  const handleRemoveCrawler = async (c) => {
    if (!confirm(`Remove crawler "${c.displayName}"?`)) return;
    try {
      await authFetch(`/api/admin/crawlers/${c.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permanent: true }) });
      fetchCrawlers();
    } catch (err) { setError(err.message); }
  };

  const toggleAudit = async (id) => {
    if (expandedAudit === id) { setExpandedAudit(null); return; }
    try {
      const r = await authFetch(`/api/admin/crawlers/${id}/audit?limit=20`);
      if (r.ok) { setAuditData(await r.json()); setExpandedAudit(id); }
    } catch (err) { setError(err.message); }
  };

  // ── Render ────────────────────────────────────────────────────

  if (loading) return <div className="p-6 text-gray-500 dark:text-gray-400">Loading...</div>;

  const showGettingStarted = status && !status.hasData && configs.length === 0 && !wizardStep;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Crawlers</h1>
        {!wizardStep && (
          <div className="flex gap-2">
            <input
              ref={importFileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
            <button onClick={() => importFileRef.current?.click()}
              title="Import a crawler configuration from a previously exported JSON file"
              className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium">
              Import
            </button>
            <button onClick={() => setWizardStep('select')}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
              Add Crawler
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between dark:bg-red-900/20 dark:border-red-700">
          <span className="text-red-700 text-sm dark:text-red-300">{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700 text-sm dark:text-red-400 dark:hover:text-red-200">Dismiss</button>
        </div>
      )}

      {/* Getting started */}
      {showGettingStarted && <GettingStarted onAddCrawler={() => setWizardStep('select')} />}

      {/* Active job progress — one card per tracked job. Queued jobs render
          a card too (JobProgress shows "Waiting for worker..." internally),
          so a user who fires off two crawlers sees both: the running one
          with its live step/pct, and the queued one waiting its turn. */}
      {activeJobs.map(j => {
        const sourceCfg = configs.find(c =>
          String(c.id) === String(j.config?._scheduledByConfigId ?? '')
        );
        return (
          <JobProgress
            key={j.id}
            job={j}
            configLabel={sourceCfg?.displayName}
            onNavigateToMatrix={() => onNavigate?.('matrix')}
            onDismiss={() => setActiveJobs(prev => prev.filter(aj => aj.id !== j.id))}
          />
        );
      })}

      {/* Wizard steps */}
      {wizardStep === 'select' && (
        <SelectType onSelect={handleSelectType} onCancel={() => setWizardStep(null)} />
      )}
      {wizardStep === 'crawler-wizard' && (() => {
        const CrawlerWizard = getCrawlerWizard(wizardCrawlerType);
        return CrawlerWizard ? (
          <Suspense fallback={<div className="p-4 text-sm text-gray-500 dark:text-gray-400">Loading…</div>}>
            <CrawlerWizard
              onComplete={() => { setWizardStep(null); setEditingConfig(null); fetchConfigs(); }}
              onCancel={() => { setWizardStep(null); setEditingConfig(null); }}
              initialConfig={editingConfig}
              isEdit={!!editingConfig?.id}
              authFetch={authFetch}
            />
          </Suspense>
        ) : null;
      })()}
      {wizardStep === 'custom-wizard' && (
        <CustomConnectorWizard
          onComplete={() => {
            setWizardStep(null);
            fetchCrawlers();
          }}
          onCancel={() => setWizardStep(null)}
          authFetch={authFetch}
        />
      )}

      {/* Configured crawlers */}
      {configs.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3 dark:text-white">Configured Crawlers</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {configs.map(c => (
              <CrawlerConfigCard
                key={c.id}
                config={c}
                onRunNow={handleRunNow}
                onEdit={handleEditConfig}
                onExport={handleExportConfig}
                onRemove={handleRemoveConfig}
                onForceStop={handleForceStop}
                runningJob={
                  // Match THIS config's running job by _scheduledByConfigId
                  // (stamped by both the scheduler and the manual-run path).
                  // Matching by jobType alone wrongly lit up the "Force
                  // Stop" button on every config of the same type when any
                  // one of them was running.
                  jobs.find(j =>
                    ['queued', 'running'].includes(j.status) &&
                    String(j.config?._scheduledByConfigId ?? '') === String(c.id)
                  ) || null
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* Recent jobs */}
      <RecentJobs jobs={jobs} onForceStop={handleForceStop} />

      {/* External crawlers (API key-based, excluding Built-in Worker) */}
      <ExternalCrawlers
        crawlers={crawlers}
        onToggle={handleToggleEnabled}
        onResetKey={handleResetKey}
        onRemove={handleRemoveCrawler}
        newKey={newKey}
        onDismissKey={() => setNewKey(null)}
        onCopy={(t) => navigator.clipboard.writeText(t)}
        expandedAudit={expandedAudit}
        auditData={auditData}
        onToggleAudit={toggleAudit}
      />
    </div>
  );
}
