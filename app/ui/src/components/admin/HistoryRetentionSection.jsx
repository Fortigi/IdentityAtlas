import { useState } from 'react';
import { useFetch } from '@ui/hooks/useFetch';
import { useAuth } from '@ui/auth/AuthGate';
export default function HistoryRetentionSection() {
  const { authFetch } = useAuth();
  const [days, setDays] = useState('');
  const [savedDays, setSavedDays] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [message, setMessage] = useState(null);

  // Load the saved retention + row count. `days`/`savedDays` are seeded from
  // each fetch (re-seeding on reload after a prune) via render-time tracking,
  // so we don't setState synchronously inside an effect.
  const { data: retention, loading, reload: load } = useFetch('/api/admin/history-retention', { authFetch });
  const totalRows = retention?.totalRows ?? null;
  const [seededRetention, setSeededRetention] = useState(null);
  if (retention && retention !== seededRetention) {
    setSeededRetention(retention);
    setDays(String(retention.retentionDays));
    setSavedDays(retention.retentionDays);
  }

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const r = await authFetch('/api/admin/history-retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionDays: parseInt(days, 10) }),
      });
      if (r.ok) {
        const j = await r.json();
        setSavedDays(j.retentionDays);
        setMessage({ kind: 'ok', text: `Retention set to ${j.retentionDays} days` });
      } else {
        const j = await r.json().catch(() => ({}));
        setMessage({ kind: 'err', text: j.error || `HTTP ${r.status}` });
      }
    } finally { setSaving(false); }
  };

  const pruneNow = async () => {
    setPruning(true);
    setMessage(null);
    try {
      const r = await authFetch('/api/admin/history-retention/prune', { method: 'POST' });
      if (r.ok) {
        const j = await r.json();
        const purgedTotal = Object.values(j.purged || {}).reduce((a, b) => a + b, 0);
        const purgedNote = purgedTotal ? `, purged ${purgedTotal} deleted record(s)` : '';
        setMessage({ kind: 'ok', text: `Pruned ${j.deleted} history row(s)${purgedNote} (older than ${j.retentionDays} days)` });
        load();
      } else {
        setMessage({ kind: 'err', text: `Prune failed (HTTP ${r.status})` });
      }
    } finally { setPruning(false); }
  };

  const dirty = String(savedDays) !== String(days);
  const valid = days !== '' && !isNaN(parseInt(days, 10)) && parseInt(days, 10) >= 0 && parseInt(days, 10) <= 3650;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5 mb-4">
      <h4 className="font-semibold text-gray-900 dark:text-white mb-1">Deleted Data &amp; History Retention</h4>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        How long deleted records and row-level change history are kept. Entities removed in a source system are
        soft-deleted (hidden but kept for audit); after this many days they&apos;re permanently purged, and audit-log
        entries older than this are pruned too. Runs automatically every 6 hours.
        Set to <code className="dark:text-gray-300">0</code> to disable purging and keep everything forever.
      </p>

      <div className="flex items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Retention (days)</label>
          <input
            type="number"
            aria-label="History retention (days)"
            min="0"
            max="3650"
            value={days}
            onChange={e => setDays(e.target.value)}
            disabled={loading}
            className="w-32 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-gray-200"
          />
        </div>
        <button
          onClick={save}
          disabled={!dirty || !valid || saving || loading}
          className="px-4 py-1.5 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 disabled:text-gray-500 dark:disabled:text-gray-400"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={pruneNow}
          disabled={pruning || loading}
          className="px-4 py-1.5 text-sm font-medium rounded border border-gray-300 dark:border-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          {pruning ? 'Pruning…' : 'Prune now'}
        </button>
        {totalRows != null && (
          <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{totalRows.toLocaleString()} history rows stored</span>
        )}
      </div>

      {message && (
        <div className={`mt-3 text-sm ${message.kind === 'ok' ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
          {message.text}
        </div>
      )}
    </div>
  );
}