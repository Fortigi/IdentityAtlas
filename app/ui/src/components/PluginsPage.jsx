import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { formatRelativeTime as formatTimeAgo } from '@ui/utils/formatters';

const statusColors = {
  succeeded: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  queued: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

// Summarise the non-meta plugin parameters for display.
function paramsSummary(params) {
  if (!params) return '';
  const skip = new Set(['rootName', 'instanceKey', 'autoRefresh']);
  return Object.entries(params)
    .filter(([k, v]) => !skip.has(k) && v !== '' && v != null && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('  ·  ');
}

const th = 'text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300';

export default function PluginsPage() {
  const { authFetch } = useAuth();
  const [trees, setTrees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/context-plugins/trees');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setTrees(body.data || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  const key = (t) => `${t.algorithmId}:${t.instanceKey}`;

  const runNow = async (t) => {
    setBusy(key(t));
    try {
      await authFetch(`/api/context-plugins/${encodeURIComponent(t.algo)}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...t.params, instanceKey: t.instanceKey }),
      });
      setTimeout(load, 1500);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">Context plugins</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 max-w-2xl">
            Each generated context tree, its configuration, and its last run. Trees refresh automatically after
            every crawl; use Run now for an ad-hoc rebuild. Create new ones in Contexts → New.
          </p>
        </div>
        <button onClick={() => { setLoading(true); load(); }} className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
          Refresh
        </button>
      </div>

      {loading && <div className="text-center text-gray-500 dark:text-gray-400 py-10">Loading…</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-4 text-red-700 dark:text-red-300 text-sm">{error}</div>}
      {!loading && !error && trees.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400 py-8">No context plugins configured yet. Create one in Contexts → New.</div>
      )}

      {!loading && !error && trees.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-700">
                <th className={th}>Plugin</th>
                <th className={th}>Tree / configuration</th>
                <th className={`${th} text-right`}>Contexts</th>
                <th className={th}>Last run</th>
                <th className={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {trees.map((t) => {
                const isBusy = busy === key(t);
                return (
                  <tr key={key(t)} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 align-top">
                    <td className="px-3 py-2 font-medium text-gray-900 dark:text-white whitespace-nowrap">{t.algoDisplayName}</td>
                    <td className="px-3 py-2">
                      <span className="font-medium text-gray-800 dark:text-gray-200">{t.rootName}</span>
                      {paramsSummary(t.params) && (
                        <span className="block text-xs text-gray-500 dark:text-gray-400">{paramsSummary(t.params)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700 dark:text-gray-300 tabular-nums">{t.contextCount}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {t.lastStatus
                        ? <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusColors[t.lastStatus] || 'bg-gray-100 dark:bg-gray-700'}`}>{t.lastStatus}</span>
                        : <span className="text-gray-400">—</span>}
                      <span className="block text-xs text-gray-400 mt-0.5">
                        {t.lastRunAt ? formatTimeAgo(t.lastRunAt) : ''}{t.lastRunBy ? ` · ${t.lastRunBy}` : ''}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => runNow(t)}
                        disabled={isBusy}
                        className="text-xs px-2 py-1 rounded text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                      >
                        {isBusy ? 'Running…' : 'Run now'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
