import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthGate';

function formatTimeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

const statusColors = {
  Success: 'bg-green-100 text-green-800',
  Failed: 'bg-red-100 text-red-800',
  PartialSuccess: 'bg-yellow-100 text-yellow-800',
};

export default function SyncLogPage() {
  const { authFetch } = useAuth();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchLogs() {
      try {
        const res = await authFetch('/api/sync-log?limit=50');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setLogs(data);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchLogs();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <h2 className="text-lg font-semibold text-gray-900">Sync Log</h2>
        <span className="text-sm text-gray-500">Last 50 sync operations</span>
      </div>

      {loading && (
        <div className="text-center text-gray-500 py-12">Loading sync log...</div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          Failed to load sync log: {error}
        </div>
      )}

      {!loading && !error && logs.length === 0 && (
        <div className="text-center text-gray-500 py-12">
          No sync log entries found. Add a crawler in Admin → Crawlers to get started.
        </div>
      )}

      {!loading && !error && logs.length > 0 && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-3 py-2 font-medium text-gray-700">Sync Type</th>
                <th className="text-left px-3 py-2 font-medium text-gray-700">Start Time</th>
                <th className="text-left px-3 py-2 font-medium text-gray-700">Time Ago</th>
                <th className="text-right px-3 py-2 font-medium text-gray-700">Duration</th>
                <th className="text-right px-3 py-2 font-medium text-gray-700">Records</th>
                <th className="text-left px-3 py-2 font-medium text-gray-700">Status</th>
                <th className="text-left px-3 py-2 font-medium text-gray-700">Table</th>
                <th className="text-left px-3 py-2 font-medium text-gray-700">Error</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.Id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium text-gray-900">{log.SyncType}</td>
                  <td className="px-3 py-2 text-gray-600 tabular-nums">{formatDateTime(log.StartTime)}</td>
                  <td className="px-3 py-2 text-gray-500">{formatTimeAgo(log.StartTime)}</td>
                  <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{formatDuration(log.DurationSeconds)}</td>
                  <td className="px-3 py-2 text-right text-gray-900 tabular-nums">{log.RecordCount.toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusColors[log.Status] || 'bg-gray-100 text-gray-700'}`}>
                      {log.Status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{log.TableName}</td>
                  <td className="px-3 py-2 text-red-600 text-xs max-w-xs truncate" title={log.ErrorMessage || ''}>
                    {log.ErrorMessage || ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
