import { useState } from 'react';
import { useFetch } from '@ui/hooks/useFetch';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { Section } from './adminUi';
export default function PowerQueryExportSection() {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [newToken, setNewToken] = useState(null); // plaintext shown once
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');

  const { data: tokens, loading, reload: refresh } = useFetch('/api/admin/read-tokens', {
    authFetch, initialData: [], onError: (e) => setError(e.message),
  });

  async function downloadWorkbook() {
    setError(null);
    setBusy(true);
    try {
      const r = await authFetch('/api/admin/data-export/workbook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Workbook generation failed');
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `IdentityAtlas-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function createTokenOnly() {
    if (!name.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const r = await authFetch('/api/admin/read-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Token creation failed');
      }
      const data = await r.json();
      setNewToken(data.token);  // plaintext, shown once
      setShowCreate(false);
      setName('');
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id) {
    if (!(await dialog.confirm({ message: 'Revoke this token? Workbooks using it will stop refreshing immediately.', confirmLabel: 'Revoke', danger: true }))) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/admin/read-tokens/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Revoke failed');
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function fmtDate(s) { return s ? new Date(s).toLocaleString() : '—'; }

  return (
    <Section title="Excel Power Query Workbook" icon="📊">
      <div className="space-y-4 text-sm">
        <p className="text-gray-700 dark:text-gray-300">
          Download a pre-configured Excel workbook with Power Query M code for every
          object type (Users, Resources, Assignments, etc). The workbook includes a
          read-only API token so refreshing the data on any user's machine just
          requires opening the file.
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={downloadWorkbook}
            disabled={busy}
            className="px-4 py-2 rounded text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Generating…' : 'Generate token & download workbook'}
          </button>
          <button
            onClick={() => { setShowCreate(true); setNewToken(null); }}
            disabled={busy}
            className="px-4 py-2 rounded text-sm font-medium text-blue-700 dark:text-blue-300 bg-white dark:bg-gray-700 border border-blue-300 dark:border-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50"
          >
            Create token only…
          </button>
        </div>

        {showCreate && (
          <div className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded">
            <input
              type="text"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createTokenOnly()}
              placeholder="Token name (e.g. 'PowerBI prod report')"
              className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-sm flex-1 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
            />
            <button
              onClick={createTokenOnly}
              disabled={!name.trim() || busy}
              className="px-3 py-1 rounded text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
            >
              Create
            </button>
            <button
              onClick={() => { setShowCreate(false); setName(''); }}
              className="px-2 py-1 rounded text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              Cancel
            </button>
          </div>
        )}

        {newToken && (
          <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded">
            <p className="font-medium text-amber-900 dark:text-amber-200 mb-1">⚠ Copy this token now — it will not be shown again</p>
            <code className="block p-2 bg-white dark:bg-gray-800 border border-amber-200 dark:border-amber-700 rounded text-xs break-all font-mono dark:text-gray-200">{newToken}</code>
            <button
              onClick={() => { navigator.clipboard.writeText(newToken); }}
              className="mt-2 px-3 py-1 rounded text-xs font-medium text-amber-900 dark:text-amber-200 bg-white dark:bg-gray-800 border border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/30"
            >
              Copy to clipboard
            </button>
            <button
              onClick={() => setNewToken(null)}
              className="mt-2 ml-2 px-3 py-1 rounded text-xs text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30"
            >
              Dismiss
            </button>
          </div>
        )}

        {error && (
          <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-700 rounded text-red-800 dark:text-red-300 text-xs">
            {error}
          </div>
        )}

        <div>
          <h4 className="font-medium text-gray-900 dark:text-white mb-2">Existing tokens</h4>
          {loading ? (
            <p className="text-gray-500 dark:text-gray-400 text-xs">Loading…</p>
          ) : tokens.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-xs">No tokens issued yet.</p>
          ) : (
            <table className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
              <thead className="bg-gray-50 dark:bg-gray-700/50">
                <tr className="text-left">
                  <th className="px-2 py-1 font-medium text-gray-700 dark:text-gray-300">Name</th>
                  <th className="px-2 py-1 font-medium text-gray-700 dark:text-gray-300">Prefix</th>
                  <th className="px-2 py-1 font-medium text-gray-700 dark:text-gray-300">Created</th>
                  <th className="px-2 py-1 font-medium text-gray-700 dark:text-gray-300">Last used</th>
                  <th className="px-2 py-1 font-medium text-gray-700 dark:text-gray-300">Status</th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {tokens.map(t => (
                  <tr key={t.id} className="border-t border-gray-100 dark:border-gray-700">
                    <td className="px-2 py-1 text-gray-900 dark:text-gray-200">{t.name}</td>
                    <td className="px-2 py-1 font-mono text-gray-600 dark:text-gray-400">{t.tokenPrefix}…</td>
                    <td className="px-2 py-1 text-gray-600 dark:text-gray-400">{fmtDate(t.createdAt)}</td>
                    <td className="px-2 py-1 text-gray-600 dark:text-gray-400">{fmtDate(t.lastUsedAt)}</td>
                    <td className="px-2 py-1">
                      {t.revoked
                        ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300">Revoked</span>
                        : t.expiresAt && new Date(t.expiresAt) < new Date()
                          ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300">Expired</span>
                          : <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">Active</span>}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {!t.revoked && (
                        <button
                          onClick={() => revoke(t.id)}
                          className="px-2 py-0.5 rounded text-[11px] text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 border border-red-200 dark:border-red-700"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Section>
  );
}