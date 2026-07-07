// Admin → Updates.
//
// Surfaces the auto-update state from the backend (PR #517): web / worker /
// database versions, whether a newer version is available, the auto-update
// switch, and the history of checks + applied updates. The app never applies
// updates itself — a deployment-specific agent does that, gated on the switch —
// so this screen is status + control, not an "install now" button.
//
// Split into small presentational sub-components so each stays easy to read (and
// under the complexity ratchet); the default export owns the data + handlers.

import { useState, useEffect, useReducer, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { formatDate, formatRelativeTime } from '@ui/utils/formatters';

const STATUS_STYLES = {
  available:    'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  'up-to-date': 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300',
  installed:    'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
  failed:       'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300',
  applying:     'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
  checked:      'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

const PILL = 'inline-block px-2 py-0.5 rounded text-[11px] font-semibold';
const AMBER_PILL = `${PILL} bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300`;
const GREEN_PILL = `${PILL} bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300`;
const ROW_LABEL = 'inline-block w-14 text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400';
const CARD = 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4';
const AMBER_BANNER = 'text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded p-3';

function StatusBadge({ status }) {
  const cls = STATUS_STYLES[status] || STATUS_STYLES.checked;
  return <span className={`${PILL} ${cls}`}>{status}</span>;
}

function MatchBadge({ mismatch }) {
  return mismatch
    ? <span className={AMBER_PILL}>Mismatch</span>
    : <span className={GREEN_PILL}>Matched</span>;
}

function AmberBanner({ children }) {
  return <div className={AMBER_BANNER}>{children}</div>;
}

function LastSeen({ at, stale }) {
  return (
    <span className={`text-[11px] ${stale ? 'text-amber-700 dark:text-amber-300' : 'text-gray-600 dark:text-gray-400'}`}>
      · last seen {formatRelativeTime(at)}{stale ? ' (stale)' : ''}
    </span>
  );
}

// One labelled version row (Web / Worker / Database).
function VersionRow({ label, version, placeholder, showBadge, mismatch, extra }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={ROW_LABEL}>{label}</span>
      {version
        ? <span className="text-sm font-mono text-gray-900 dark:text-white">{version}</span>
        : <span className="text-xs italic text-gray-500 dark:text-gray-400">{placeholder}</span>}
      {showBadge && <MatchBadge mismatch={mismatch} />}
      {extra}
    </div>
  );
}

function AvailabilityBadge({ pinned, updateAvailable, latest }) {
  if (pinned) {
    return <span className="inline-block px-2.5 py-1 rounded text-xs font-semibold bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">Pinned — auto-update not applicable</span>;
  }
  if (updateAvailable) {
    return <span className="inline-block px-2.5 py-1 rounded text-xs font-semibold bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">Update available: <span className="font-mono">{latest}</span></span>;
  }
  return <span className="inline-block px-2.5 py-1 rounded text-xs font-semibold bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300">Up to date</span>;
}

function IntroCard({ channel }) {
  return (
    <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg p-4">
      <div className="text-sm font-medium text-blue-900 dark:text-blue-200">Updates</div>
      <div className="text-xs text-blue-700 dark:text-blue-300 mt-0.5">
        Identity Atlas checks once a day for a newer version on its release channel
        (<span className="font-mono">{channel}</span>) and reports it here — but it never installs updates
        itself. Installing is done by a separate update agent running on your deployment; the switch below
        tells that agent whether it may apply new versions. Updates stay on the same channel — edge stays on
        edge, beta on beta, latest on latest.
      </div>
    </div>
  );
}

// The amber "something needs attention" banners: nothing applying, web/worker
// skew, and DB schema ahead of the app.
function UpdateBanners({ status }) {
  const { currentVersion = 'unknown', latestVersion = null, lastCheck = null,
          components = {}, skew = {}, applyStalled = false } = status || {};
  const latest = latestVersion || (lastCheck && lastCheck.latestVersion) || null;
  const worker = components.worker || null;
  const database = components.database || null;
  return (
    <>
      {applyStalled && (
        <AmberBanner>
          <span className="font-semibold">Automatic updates are on, but nothing is installing them.</span>{' '}
          Version <span className="font-mono">{latest}</span> has been available for a while and hasn't been
          applied. Installing updates needs a separate update agent running on your deployment — check that
          it's installed and running.
        </AmberBanner>
      )}
      {skew.mismatch && (
        <AmberBanner>
          <span className="font-semibold">Web and worker are running different versions.</span>{' '}
          The web app is on <span className="font-mono">{currentVersion}</span> and the worker on{' '}
          <span className="font-mono">{worker && worker.version}</span>. These are updated together and should
          match — a mismatch usually means an update was interrupted or only half-applied, and normally clears
          on the next successful update.
        </AmberBanner>
      )}
      {database && database.ahead && (
        <AmberBanner>
          <span className="font-semibold">The database schema is newer than the running app.</span>{' '}
          The database was last migrated by <span className="font-mono">{database.version}</span> but the app
          is running <span className="font-mono">{currentVersion}</span> — usually a sign the app was rolled
          back or an update was only half-applied. Some features may misbehave until the app is back on a build
          that matches the schema.
        </AmberBanner>
      )}
    </>
  );
}

function WorkerRow({ worker, mismatch }) {
  const version = worker && worker.version;
  return (
    <VersionRow
      label="Worker"
      version={version}
      placeholder="not reported yet"
      showBadge={!!version}
      mismatch={mismatch}
      extra={worker && worker.lastSeenAt
        ? <LastSeen at={worker.lastSeenAt} stale={!!(worker && worker.stale)} />
        : null}
    />
  );
}

function DatabaseRow({ database }) {
  const version = database && database.version;
  return (
    <VersionRow
      label="Database"
      version={version}
      placeholder="not stamped yet"
      showBadge={!!version}
      mismatch={!!(database && database.mismatch)}
    />
  );
}

function VersionCard({ status, checking, onCheck }) {
  const s = status || {};
  const channel = s.channel || 'unknown';
  const components = s.components || {};
  const last = s.lastCheck || null;
  const latest = s.latestVersion || (last && last.latestVersion) || null;
  const pinned = channel === 'pinned';
  const mismatch = !!(s.skew && s.skew.mismatch);

  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Version</h3>
          <div className="mt-1 space-y-1">
            <VersionRow label="Web" version={s.currentVersion || 'unknown'} />
            <WorkerRow worker={components.worker || null} mismatch={mismatch} />
            <DatabaseRow database={components.database || null} />
          </div>
          <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-2">
            Channel <span className="font-mono">{channel}</span>
            {last && last.createdAt && <> · last checked {formatRelativeTime(last.createdAt)}</>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <AvailabilityBadge pinned={pinned} updateAvailable={!!s.updateAvailable} latest={latest} />
          <button
            onClick={onCheck}
            disabled={checking}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AutoUpdateToggle({ enabled, pinned, saving, onToggle }) {
  return (
    <div className={CARD}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Automatic updates</h3>
          <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-1">
            Identity Atlas never installs updates itself. When on, it tells your deployment's separate
            update agent it may install newer versions on this channel. When off, new versions are only
            reported here and nothing is installed.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={saving || pinned}
            onChange={e => onToggle(e.target.checked)}
            className="h-4 w-4 accent-blue-600"
          />
          {enabled ? 'Enabled' : 'Disabled'}
        </label>
      </div>
    </div>
  );
}

function HistoryRow({ row }) {
  const version = row.status === 'installed' && row.currentVersion && row.latestVersion
    ? `${row.currentVersion} → ${row.latestVersion}`
    : row.latestVersion || row.currentVersion || '—';
  return (
    <tr className="text-gray-700 dark:text-gray-300">
      <td className="py-1.5 pr-4 whitespace-nowrap" title={formatDate(row.createdAt)}>{formatRelativeTime(row.createdAt)}</td>
      <td className="py-1.5 pr-4"><StatusBadge status={row.status} /></td>
      <td className="py-1.5 pr-4 font-mono">{row.channel}</td>
      <td className="py-1.5 pr-4 font-mono">{version}</td>
      <td className="py-1.5 pr-4 text-gray-600 dark:text-gray-400">{row.source || '—'}</td>
    </tr>
  );
}

function UpdateHistory({ log }) {
  return (
    <div className={CARD}>
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Update history</h3>
      {log.length === 0 ? (
        <p className="text-xs text-gray-600 dark:text-gray-400">No update checks recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400 uppercase tracking-wide border-b border-gray-200 dark:border-gray-700">
                <th className="py-1.5 pr-4 font-semibold">When</th>
                <th className="py-1.5 pr-4 font-semibold">Status</th>
                <th className="py-1.5 pr-4 font-semibold">Channel</th>
                <th className="py-1.5 pr-4 font-semibold">Version</th>
                <th className="py-1.5 pr-4 font-semibold">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
              {log.map(row => <HistoryRow key={row.id} row={row} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function UpdatesSettings() {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [status, setStatus] = useState(null);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useReducer((_, v) => v, true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      authFetch('/api/admin/updates/status').then(r => r.json()),
      authFetch('/api/admin/updates/log').then(r => r.json()),
    ])
      .then(([s, l]) => { setStatus(s); setLog(Array.isArray(l?.data) ? l.data : []); })
      .catch(() => setError('Failed to load update status.'))
      .finally(() => setLoading(false));
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  const toggleAuto = async (enabled) => {
    setError(null);
    setSaving(true);
    setStatus(s => ({ ...s, autoUpdateEnabled: enabled })); // optimistic
    try {
      const r = await authFetch('/api/admin/updates/auto', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      dialog.toast(enabled ? 'Automatic updates enabled' : 'Automatic updates disabled', { variant: 'success' });
    } catch (e) {
      setStatus(s => ({ ...s, autoUpdateEnabled: !enabled })); // revert
      setError(`Could not save setting: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const checkNow = async () => {
    setError(null);
    setChecking(true);
    try {
      const r = await authFetch('/api/admin/updates/check', { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(`Check failed: ${e.message}`);
    } finally {
      setChecking(false);
    }
  };

  if (loading) return <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">Loading…</p>;

  const channel = (status && status.channel) || 'unknown';
  const enabled = !!(status && status.autoUpdateEnabled);
  const pinned = channel === 'pinned';

  return (
    <div className="mt-4 space-y-4">
      <IntroCard channel={channel} />

      {error && (
        <div className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded p-3">{error}</div>
      )}

      <UpdateBanners status={status} />
      <VersionCard status={status} checking={checking} onCheck={checkNow} />
      <AutoUpdateToggle enabled={enabled} pinned={pinned} saving={saving} onToggle={toggleAuto} />
      <UpdateHistory log={log} />
    </div>
  );
}
