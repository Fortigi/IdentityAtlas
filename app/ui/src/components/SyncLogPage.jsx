import { useState, useEffect } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { formatRelativeTime as formatTimeAgo, formatDurationSeconds as formatDuration } from '@ui/utils/formatters';

function formatDateTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

const statusColors = {
  Success: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  Failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  PartialSuccess: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  succeeded: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  queued: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  cancelled: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
};

function StatusBadge({ status }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusColors[status] || 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}>
      {status}
    </span>
  );
}

const th = 'text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300';

export default function SyncLogPage() {
  const { authFetch } = useAuth();
  const [logs, setLogs] = useState([]);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [logRes, runRes] = await Promise.all([
          authFetch('/api/sync-log?limit=50'),
          authFetch('/api/context-plugins/runs?limit=50').catch(() => null),
        ]);
        if (!logRes.ok) throw new Error(`HTTP ${logRes.status}`);
        const logData = await logRes.json();
        let runData = [];
        if (runRes && runRes.ok) {
          const r = await runRes.json();
          runData = Array.isArray(r) ? r : (r.runs || []);
        }
        if (!cancelled) { setLogs(logData); setRuns(runData); }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authFetch]);

  return (
    <div className="max-w-6xl mx-auto space-y-10">
      <div className="flex items-center gap-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Logs</h2>
        <span className="text-sm text-gray-500 dark:text-gray-400">Crawler syncs &amp; context plugin runs</span>
      </div>

      {loading && <div className="text-center text-gray-500 dark:text-gray-400 py-12">Loading…</div>}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-4 text-red-700 dark:text-red-300 text-sm">
          Failed to load: {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* ── Crawler syncs ── */}
          <section>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
              Crawler syncs <span className="font-normal text-gray-400">(last 50)</span>
            </h3>
            {logs.length === 0 ? (
              <div className="text-sm text-gray-500 dark:text-gray-400 py-4">
                No sync log entries yet. Add a crawler in Admin → Crawlers to get started.
              </div>
            ) : (
              <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-700">
                      <th className={th}>Sync Type</th>
                      <th className={th}>Start Time</th>
                      <th className={th}>Time Ago</th>
                      <th className={`${th} text-right`}>Duration</th>
                      <th className={`${th} text-right`}>Records</th>
                      <th className={th}>Status</th>
                      <th className={th}>Table</th>
                      <th className={th}>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.Id} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{log.SyncType}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400 tabular-nums">{formatDateTime(log.StartTime)}</td>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{formatTimeAgo(log.StartTime)}</td>
                        <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400 tabular-nums">{formatDuration(log.DurationSeconds)}</td>
                        <td className="px-3 py-2 text-right text-gray-900 dark:text-white tabular-nums">{(log.RecordCount ?? 0).toLocaleString()}</td>
                        <td className="px-3 py-2"><StatusBadge status={log.Status} /></td>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs">{log.TableName}</td>
                        <td className="px-3 py-2 text-red-600 dark:text-red-400 text-xs max-w-xs truncate" title={log.ErrorMessage || ''}>{log.ErrorMessage || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Context plugin runs ── */}
          <section>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
              Context plugin runs <span className="font-normal text-gray-400">(last 50)</span>
            </h3>
            {runs.length === 0 ? (
              <div className="text-sm text-gray-500 dark:text-gray-400 py-4">
                No plugin runs yet. Generate a context in Contexts → New, or they'll appear here automatically after each crawl.
              </div>
            ) : (
              <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-700">
                      <th className={th}>Plugin</th>
                      <th className={th}>Tree</th>
                      <th className={th}>Status</th>
                      <th className={th}>Started</th>
                      <th className={th}>Time Ago</th>
                      <th className={th}>Triggered by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{r.algorithmDisplayName || r.algorithmName}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{r.parameters?.rootName || '—'}</td>
                        <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400 tabular-nums">{formatDateTime(r.startedAt)}</td>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{r.startedAt ? formatTimeAgo(r.startedAt) : ''}</td>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs">{r.triggeredBy || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
