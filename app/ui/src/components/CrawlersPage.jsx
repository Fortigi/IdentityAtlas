import { useState, useEffect, useCallback, useRef, useTransition, Suspense, lazy, createElement } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { formatDurationSeconds as formatDurationHMS } from '@ui/utils/formatters';
import { Modal } from './contexts/ModalPrimitives';
import { JobPhasesModal } from './JobPhasesModal';

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

// ─── Step 1: Select Type ──────────────────────────────────────────────────────
function SelectType({ onSelect, onCancel }) {
  return (
    <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg dark:bg-gray-800 dark:border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold dark:text-white">Add Crawler — Select Type</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-700 text-sm dark:text-gray-400 dark:hover:text-gray-200">Cancel</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {_discoveredCrawlerTypes.map(t => (
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
function CrawlerConfigCard({ config, onRunNow, onEdit, onRemove, onExport, onForceStop, runningJob, authFetch }) {
  const cfg = config.config || {};

  // Sync mode is now chosen per-run: two buttons (Run Delta / Run Full)
  // on this card, or per-schedule via the Mode dropdown on each schedule
  // entry. The old `nextRunMode` column on CrawlerConfigs still works as
  // a server-side scheduler fallback but has no UI surface anymore.

  const isRunning = runningJob && ['queued', 'running'].includes(runningJob.status);

  // Push-mode types (e.g. Custom Connector — data arrives via the Ingest API,
  // there's no scheduled job, no editable config, nothing meaningful to
  // export) opt out of these generic actions via CrawlerMeta.js. Defaults to
  // true so existing types need no changes.
  const meta = _discoveredCrawlerTypes.find(t => t.id === config.crawlerType);
  const supportsRun = meta?.supportsRun !== false;
  const supportsConfigure = meta?.supportsConfigure !== false;
  const supportsExport = meta?.supportsExport !== false;

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
      <div className="mb-3">
        <div className="mb-2">
          <h4 className="font-semibold text-gray-900 dark:text-white">{config.displayName}</h4>
          <span className="text-xs text-gray-500 dark:text-gray-400">{config.crawlerType}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {supportsRun && (isRunning ? (
            <button
              onClick={() => onForceStop(runningJob.id)}
              className="px-3 py-1 text-xs whitespace-nowrap bg-red-600 text-white rounded hover:bg-red-700"
            >
              Force Stop
            </button>
          ) : (
            <>
              <button
                onClick={() => onRunNow(config.id, 'delta')}
                title="Queue a delta run — fetches only what changed since the last successful sync."
                className="px-3 py-1 text-xs whitespace-nowrap bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Run Delta
              </button>
              <button
                onClick={() => onRunNow(config.id, 'full')}
                title="Queue a full run — re-fetches everything, resets delta tokens."
                className="px-3 py-1 text-xs whitespace-nowrap bg-amber-600 text-white rounded hover:bg-amber-700"
              >
                Run Full
              </button>
            </>
          ))}
          {supportsConfigure && (
            <button onClick={() => onEdit(config)}
              className="px-3 py-1 text-xs whitespace-nowrap bg-gray-100 rounded hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
              Configure
            </button>
          )}
          {supportsExport && (
            <button onClick={() => onExport(config)}
              title="Download this crawler's configuration as JSON (client secret is stripped)"
              className="px-3 py-1 text-xs whitespace-nowrap bg-gray-100 rounded hover:bg-gray-200">
              Export
            </button>
          )}
          <button onClick={() => onRemove(config.id)}
            className="px-3 py-1 text-xs whitespace-nowrap bg-red-100 text-red-700 rounded hover:bg-red-200 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40">
            Remove
          </button>
        </div>
      </div>

      {(() => {
        const Summary = getCrawlerSummary(config.crawlerType);
        return Summary ? createElement(Summary, { cfg, config, authFetch }) : null;
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
  }, [job]);

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
// Main CrawlersPage
// ═══════════════════════════════════════════════════════════════════════════════

export default function CrawlersPage({ onNavigate }) {
  const { authFetch } = useAuth();
  const [, startTransition] = useTransition();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);

  // Data
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

  // Wizard state — 'select' (type picker), 'crawler-wizard' (generic)
  const [wizardStep, setWizardStep] = useState(null);
  // For 'crawler-wizard': which crawler type's wizard to render
  const [wizardCrawlerType, setWizardCrawlerType] = useState(null);
  // When editing an existing config, holds its full data + id; null otherwise
  const [editingConfig, setEditingConfig] = useState(null);

  // ── Fetchers ──────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try { const r = await authFetch('/api/admin/status'); if (r.ok) setStatus(await r.json()); } catch {}
  }, [authFetch]);

  const fetchConfigs = useCallback(async () => {
    try { const r = await authFetch('/api/admin/crawler-configs'); if (r.ok) setConfigs(await r.json()); } catch {}
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
    startTransition(() => {
      Promise.all([fetchConfigs(), fetchStatus(), fetchJobs()])
        .finally(() => setLoading(false));
    });
  }, [fetchConfigs, fetchStatus, fetchJobs, startTransition]);

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
    if (getCrawlerWizard(type)) {
      setEditingConfig(null);
      setWizardCrawlerType(type); setWizardStep('crawler-wizard');
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

  const handleForceStop = (jobId) => {
    setConfirmDialog({
      message: 'Force-stop this running job? Any partially imported data will remain.',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await authFetch(`/api/admin/crawler-jobs/${jobId}/force-stop`, { method: 'POST' });
          fetchJobs();
        } catch (err) {
          setError(err.message);
        }
      },
    });
  };

  const handleRemoveConfig = (configId) => {
    setConfirmDialog({
      message: 'Remove this crawler configuration?',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await authFetch(`/api/admin/crawler-configs/${configId}`, { method: 'DELETE' });
          fetchConfigs();
        } catch (err) {
          setError(err.message);
        }
      },
    });
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
              onComplete={() => { setWizardStep(null); setEditingConfig(null); fetchConfigs(); fetchJobs(); }}
              onCancel={() => { setWizardStep(null); setEditingConfig(null); }}
              initialConfig={editingConfig}
              isEdit={!!editingConfig?.id}
              authFetch={authFetch}
            />
          </Suspense>
        ) : null;
      })()}

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
                authFetch={authFetch}
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

      {confirmDialog && (
        <Modal title="Confirm" onClose={() => setConfirmDialog(null)} width={360} dismissOnBackdrop={false}>
          <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">{confirmDialog.message}</p>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setConfirmDialog(null)}
              className="px-3 py-1 text-xs rounded bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            >
              Cancel
            </button>
            <button
              onClick={confirmDialog.onConfirm}
              className="px-3 py-1 text-xs rounded bg-red-600 text-white hover:bg-red-700"
            >
              Confirm
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
