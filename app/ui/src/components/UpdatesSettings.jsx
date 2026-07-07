// Admin → Updates.
//
// Surfaces the auto-update state from the backend (PR #517): the running version
// and channel, whether a newer version is available, the auto-update switch, and
// the history of checks + applied updates. The app never applies updates itself —
// a deployment-specific agent does that, gated on the switch — so this screen is
// status + control, not an "install now" button.

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

function StatusBadge({ status }) {
  const cls = STATUS_STYLES[status] || STATUS_STYLES.checked;
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${cls}`}>{status}</span>;
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

  const channel = status?.channel || 'unknown';
  const webVersion = status?.currentVersion || 'unknown';
  const last = status?.lastCheck || null;
  const updateAvailable = !!status?.updateAvailable;
  const latest = status?.latestVersion || last?.latestVersion || null;
  const enabled = !!status?.autoUpdateEnabled;
  const pinned = channel === 'pinned';
  const worker = status?.components?.worker || null;
  const workerVersion = worker?.version || null;
  const workerLastSeen = worker?.lastSeenAt || null;
  const workerStale = !!status?.skew?.workerStale;
  const skewMismatch = !!status?.skew?.mismatch;
  const applyStalled = !!status?.applyStalled;

  return (
    <div className="mt-4 space-y-4">
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

      {error && (
        <div className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded p-3">{error}</div>
      )}

      {applyStalled && (
        <div className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded p-3">
          <span className="font-semibold">Automatic updates are on, but nothing is installing them.</span>{' '}
          Version <span className="font-mono">{latest}</span> has been available for a while and hasn't been
          applied. Installing updates needs a separate update agent running on your deployment — check that
          it's installed and running.
        </div>
      )}

      {skewMismatch && (
        <div className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded p-3">
          <span className="font-semibold">Web and worker are running different versions.</span>{' '}
          The web app is on <span className="font-mono">{webVersion}</span> and the worker on{' '}
          <span className="font-mono">{workerVersion}</span>. These are updated together and should match —
          a mismatch usually means an update was interrupted or only half-applied, and normally clears on the
          next successful update.
        </div>
      )}

      {/* Component versions + availability */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Version</h3>
            <div className="mt-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="inline-block w-14 text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Web</span>
                <span className="text-sm font-mono text-gray-900 dark:text-white">{webVersion}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-block w-14 text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Worker</span>
                {workerVersion ? (
                  <span className="text-sm font-mono text-gray-900 dark:text-white">{workerVersion}</span>
                ) : (
                  <span className="text-xs italic text-gray-500 dark:text-gray-400">not reported yet</span>
                )}
                {workerVersion && (skewMismatch ? (
                  <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">Mismatch</span>
                ) : (
                  <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300">Matched</span>
                ))}
                {workerLastSeen && (
                  <span className={`text-[11px] ${workerStale ? 'text-amber-700 dark:text-amber-300' : 'text-gray-600 dark:text-gray-400'}`}>
                    · last seen {formatRelativeTime(workerLastSeen)}{workerStale ? ' (stale)' : ''}
                  </span>
                )}
              </div>
            </div>
            <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-2">
              Channel <span className="font-mono">{channel}</span>
              {last?.createdAt && <> · last checked {formatRelativeTime(last.createdAt)}</>}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {pinned ? (
              <span className="inline-block px-2.5 py-1 rounded text-xs font-semibold bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                Pinned — auto-update not applicable
              </span>
            ) : updateAvailable ? (
              <span className="inline-block px-2.5 py-1 rounded text-xs font-semibold bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                Update available: <span className="font-mono">{latest}</span>
              </span>
            ) : (
              <span className="inline-block px-2.5 py-1 rounded text-xs font-semibold bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300">
                Up to date
              </span>
            )}
            <button
              onClick={checkNow}
              disabled={checking}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              {checking ? 'Checking…' : 'Check now'}
            </button>
          </div>
        </div>
      </div>

      {/* Auto-update switch */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
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
              onChange={e => toggleAuto(e.target.checked)}
              className="h-4 w-4 accent-blue-600"
            />
            {enabled ? 'Enabled' : 'Disabled'}
          </label>
        </div>
      </div>

      {/* History */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
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
                {log.map(row => (
                  <tr key={row.id} className="text-gray-700 dark:text-gray-300">
                    <td className="py-1.5 pr-4 whitespace-nowrap" title={formatDate(row.createdAt)}>{formatRelativeTime(row.createdAt)}</td>
                    <td className="py-1.5 pr-4"><StatusBadge status={row.status} /></td>
                    <td className="py-1.5 pr-4 font-mono">{row.channel}</td>
                    <td className="py-1.5 pr-4 font-mono">
                      {row.status === 'installed' && row.currentVersion && row.latestVersion
                        ? `${row.currentVersion} → ${row.latestVersion}`
                        : row.latestVersion || row.currentVersion || '—'}
                    </td>
                    <td className="py-1.5 pr-4 text-gray-600 dark:text-gray-400">{row.source || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
