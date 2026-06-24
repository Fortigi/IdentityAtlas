import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { formatRelativeTime as formatTimeAgo } from '@ui/utils/formatters';

const statusColors = {
  succeeded: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  queued: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

const th = 'text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300';

export default function AutomationPage({ onNavigate }) {
  const { authFetch } = useAuth();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/post-crawl-jobs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setJobs(body.data || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  const post = (id, payload) => authFetch(`/api/post-crawl-jobs/${id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });

  const toggle = async (j) => {
    setBusy(j.id);
    try { await post(j.id, { enabled: !j.enabled }); await load(); } finally { setBusy(null); }
  };

  const move = async (idx, dir) => {
    const a = jobs[idx];
    const b = jobs[idx + dir];
    if (!a || !b) return;
    setBusy(a.id);
    try {
      await post(a.id, { order: b.order });
      await post(b.id, { order: a.order });
      await load();
    } finally { setBusy(null); }
  };

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-base font-semibold text-gray-900 dark:text-white">Post-crawl automation</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 max-w-3xl">
          These derived-data jobs run automatically after every crawl, in order, each completing before the
          next — so account linking finishes before contexts rebuild, and risk scoring runs on the result.
          Turn any of them off, or reorder them. Each job's own settings live behind <em>Configure</em>.
        </p>
      </div>

      {loading && <div className="text-center text-gray-500 dark:text-gray-400 py-10">Loading…</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-4 text-red-700 dark:text-red-300 text-sm">{error}</div>}

      {!loading && !error && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-700">
                <th className={`${th} w-16`}>Order</th>
                <th className={th}>Job</th>
                <th className={th}>Run after crawl</th>
                <th className={th}>Last run</th>
                <th className={th}>Configure</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j, idx) => {
                const isBusy = busy === j.id;
                return (
                  <tr key={j.id} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <span className="tabular-nums text-gray-500 dark:text-gray-400 w-4">{idx + 1}</span>
                        <div className="flex flex-col">
                          <button disabled={idx === 0 || isBusy} onClick={() => move(idx, -1)} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30 leading-none text-xs">▲</button>
                          <button disabled={idx === jobs.length - 1 || isBusy} onClick={() => move(idx, 1)} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30 leading-none text-xs">▼</button>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{j.name}</td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => toggle(j)}
                        disabled={isBusy}
                        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border disabled:opacity-50 ${
                          j.enabled
                            ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-300 dark:border-green-700'
                            : 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600'
                        }`}
                      >
                        <span className={`w-2 h-2 rounded-full ${j.enabled ? 'bg-green-500' : 'bg-gray-400'}`} />
                        {j.enabled ? 'On' : 'Off'}
                      </button>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {j.lastRun
                        ? <>
                            <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusColors[j.lastRun.status] || 'bg-gray-100 dark:bg-gray-700'}`}>{j.lastRun.status}</span>
                            <span className="block text-xs text-gray-400 mt-0.5">{j.lastRun.startedAt ? formatTimeAgo(j.lastRun.startedAt) : ''}{j.lastRun.triggeredBy ? ` · ${j.lastRun.triggeredBy}` : ''}</span>
                          </>
                        : <span className="text-gray-400">never run</span>}
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => onNavigate?.(`admin?sub=${j.configTab}`)} className="text-blue-600 dark:text-blue-400 hover:underline text-xs font-medium whitespace-nowrap">
                        Configure →
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
