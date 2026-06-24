import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { formatRelativeTime as formatTimeAgo } from '@ui/utils/formatters';

function formatDateTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// One entry kind → a coloured chip.
const KINDS = {
  crawler: { label: 'Crawler sync',    color: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300' },
  plugin:  { label: 'Plugin run',      color: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300' },
  linking: { label: 'Account linking', color: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300' },
};

const statusColors = {
  Success: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  Failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  PartialSuccess: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  succeeded: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  queued: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  cancelled: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
};

function Badge({ value, map }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${(map && map[value]) || 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}>
      {value}
    </span>
  );
}

export default function SyncLogPage({ navigate, onOpenDetail }) {
  const { authFetch } = useAuth();
  const [logs, setLogs] = useState([]);
  const [runs, setRuns] = useState([]);
  const [linkRuns, setLinkRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [kind, setKind] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [logRes, runRes, linkRes] = await Promise.all([
          authFetch('/api/sync-log?limit=200'),
          authFetch('/api/context-plugins/runs?limit=200').catch(() => null),
          authFetch('/api/account-linking/runs').catch(() => null),
        ]);
        if (!logRes.ok) throw new Error(`HTTP ${logRes.status}`);
        const logData = await logRes.json();
        let runData = [];
        if (runRes && runRes.ok) { const r = await runRes.json(); runData = Array.isArray(r) ? r : (r.data || r.runs || []); }
        let linkData = [];
        if (linkRes && linkRes.ok) { const l = await linkRes.json(); linkData = Array.isArray(l) ? l : (l.data || l.runs || []); }
        if (!cancelled) { setLogs(logData); setRuns(runData); setLinkRuns(linkData); }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authFetch]);

  // Normalise the three sources into one time-sorted activity stream, each row
  // linking back to whatever produced it.
  const entries = useMemo(() => {
    const out = [];
    for (const l of logs) {
      out.push({
        id: `c:${l.Id}`, kind: 'crawler',
        title: l.SyncType,
        subtitle: `${l.TableName || ''}${l.RecordCount != null ? ` · ${l.RecordCount.toLocaleString()} records` : ''}`,
        status: l.Status, time: l.StartTime, triggeredBy: '—',
        link: { label: 'Crawlers', go: () => navigate?.('admin?sub=crawlers') },
      });
    }
    for (const r of runs) {
      out.push({
        id: `p:${r.id}`, kind: 'plugin',
        title: r.algorithmDisplayName || r.algorithmName,
        subtitle: r.parameters?.rootName || '',
        status: r.status, time: r.startedAt, triggeredBy: r.triggeredBy || '—',
        link: { label: 'Open run', go: () => onOpenDetail?.('run', r.id) },
      });
    }
    for (const r of linkRuns) {
      out.push({
        id: `a:${r.id}`, kind: 'linking',
        title: 'Account linking',
        subtitle: r.errorMessage || r.step || '',
        status: r.status, time: r.startedAt, triggeredBy: r.triggeredBy || '—',
        link: { label: 'Account Linking', go: () => navigate?.('admin?sub=account-linking') },
      });
    }
    out.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
    return out;
  }, [logs, runs, linkRuns, navigate, onOpenDetail]);

  const counts = useMemo(() => {
    const c = { all: entries.length, crawler: 0, plugin: 0, linking: 0 };
    for (const e of entries) c[e.kind]++;
    return c;
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) =>
      (kind === 'all' || e.kind === kind) &&
      (!q || `${e.title} ${e.subtitle} ${e.triggeredBy}`.toLowerCase().includes(q)),
    );
  }, [entries, kind, search]);

  const chips = [
    { key: 'all', label: 'All' },
    { key: 'crawler', label: 'Crawler syncs' },
    { key: 'plugin', label: 'Plugin runs' },
    { key: 'linking', label: 'Account linking' },
  ];
  const th = 'text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300 sticky top-0 bg-gray-50 dark:bg-gray-700 z-10';

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center gap-4 mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Logs</h2>
        <span className="text-sm text-gray-500 dark:text-gray-400">Crawler syncs, context plugin runs &amp; account linking</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="inline-flex rounded border border-gray-300 dark:border-gray-600 overflow-hidden">
          {chips.map((c) => (
            <button
              key={c.key}
              onClick={() => setKind(c.key)}
              className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                kind === c.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              {c.label} <span className="opacity-70">{counts[c.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name, tree or who triggered it…"
          className="text-sm px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 w-72"
        />
      </div>

      {loading && <div className="text-center text-gray-500 dark:text-gray-400 py-12">Loading…</div>}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-4 text-red-700 dark:text-red-300 text-sm">
          Failed to load: {error}
        </div>
      )}

      {!loading && !error && (
        filtered.length === 0 ? (
          <div className="text-sm text-gray-500 dark:text-gray-400 py-8">No log entries match.</div>
        ) : (
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-auto" style={{ maxHeight: '70vh' }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-700">
                  <th className={th}>Type</th>
                  <th className={th}>Item</th>
                  <th className={th}>Status</th>
                  <th className={th}>When</th>
                  <th className={th}>Triggered by</th>
                  <th className={th}>Source</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-3 py-2"><Badge value={KINDS[e.kind].label} map={{ [KINDS[e.kind].label]: KINDS[e.kind].color }} /></td>
                    <td className="px-3 py-2">
                      <span className="font-medium text-gray-900 dark:text-white">{e.title}</span>
                      {e.subtitle && <span className="block text-xs text-gray-500 dark:text-gray-400 truncate max-w-md" title={e.subtitle}>{e.subtitle}</span>}
                    </td>
                    <td className="px-3 py-2"><Badge value={e.status} map={statusColors} /></td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-400 tabular-nums whitespace-nowrap">
                      {formatDateTime(e.time)}
                      <span className="block text-xs text-gray-400">{e.time ? formatTimeAgo(e.time) : ''}</span>
                    </td>
                    <td className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs">{e.triggeredBy}</td>
                    <td className="px-3 py-2">
                      <button
                        onClick={e.link.go}
                        className="text-blue-600 dark:text-blue-400 hover:underline text-xs font-medium whitespace-nowrap"
                      >
                        {e.link.label} →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
