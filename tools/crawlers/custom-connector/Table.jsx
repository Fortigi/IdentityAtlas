import { useState, useEffect, useCallback } from 'react';
import { formatDate } from '../../../app/ui/src/utils/formatters';

// ─── Custom Connectors Table (API key crawlers) ──────────────────────────────
// Unlike ConfigWizard.jsx/Summary.jsx, this isn't a per-CrawlerConfigs-row
// panel — Custom Connectors are a separate API-key entity, not CrawlerConfigs
// rows, so this renders as one self-contained list of N independent items.
// See tools/crawlers/CLAUDE.md -> "Table.jsx" for the contract.
export default function Table({ authFetch }) {
  const [crawlers, setCrawlers] = useState([]);
  const [newKey, setNewKey] = useState(null);
  const [expandedAudit, setExpandedAudit] = useState(null);
  const [auditData, setAuditData] = useState({ data: [], total: 0 });
  const [error, setError] = useState(null);

  const fetchCrawlers = useCallback(async () => {
    try {
      const r = await authFetch('/api/admin/crawlers');
      if (r.ok) setCrawlers(await r.json());
    } catch {}
  }, [authFetch]);

  useEffect(() => { fetchCrawlers(); }, [fetchCrawlers]);

  const handleToggleEnabled = async (c) => {
    try {
      await authFetch(`/api/admin/crawlers/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !c.enabled }) });
      fetchCrawlers();
    } catch (err) { setError(err.message); }
  };

  const handleResetKey = async (c) => {
    if (!confirm(`Reset API key for "${c.displayName}"?`)) return;
    try {
      const r = await authFetch(`/api/admin/crawlers/${c.id}/reset`, { method: 'POST' });
      if (r.ok) { const d = await r.json(); setNewKey(d.apiKey); fetchCrawlers(); }
    } catch (err) { setError(err.message); }
  };

  const handleRemoveCrawler = async (c) => {
    if (!confirm(`Remove crawler "${c.displayName}"?`)) return;
    try {
      await authFetch(`/api/admin/crawlers/${c.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permanent: true }) });
      fetchCrawlers();
    } catch (err) { setError(err.message); }
  };

  const toggleAudit = async (id) => {
    if (expandedAudit === id) { setExpandedAudit(null); return; }
    try {
      const r = await authFetch(`/api/admin/crawlers/${id}/audit?limit=20`);
      if (r.ok) { setAuditData(await r.json()); setExpandedAudit(id); }
    } catch (err) { setError(err.message); }
  };

  const visible = crawlers.filter(c => c.displayName !== 'Built-in Worker');
  if (visible.length === 0) return null;

  return (
    <div className="mb-6">
      <h3 className="text-lg font-semibold mb-3 dark:text-white">Custom Connectors</h3>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between dark:bg-red-900/20 dark:border-red-700">
          <span className="text-red-700 text-sm dark:text-red-300">{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700 text-sm dark:text-red-400 dark:hover:text-red-200">Dismiss</button>
        </div>
      )}

      {newKey && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg dark:bg-green-900/20 dark:border-green-700">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-green-800 dark:text-green-300">API Key Generated</span>
            <button onClick={() => setNewKey(null)} className="text-green-600 hover:text-green-800 text-sm dark:text-green-400 dark:hover:text-green-200">Dismiss</button>
          </div>
          <p className="text-sm text-green-700 mb-2 dark:text-green-400">Store this key securely. It will not be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 p-2 bg-white border border-gray-200 rounded font-mono text-sm break-all dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200">{newKey}</code>
            <button onClick={() => navigator.clipboard.writeText(newKey)} className="px-3 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700">Copy</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className="text-left p-3 font-medium dark:text-gray-300">Name</th>
              <th className="text-left p-3 font-medium dark:text-gray-300">Key Prefix</th>
              <th className="text-left p-3 font-medium dark:text-gray-300">Status</th>
              <th className="text-left p-3 font-medium dark:text-gray-300">Last Used</th>
              <th className="text-right p-3 font-medium dark:text-gray-300">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-gray-700">
            {visible.map(c => (
              <tr key={c.id}>
                <td className="p-3">
                  <div className="font-medium dark:text-gray-200">{c.displayName}</div>
                  {c.description && <div className="text-xs text-gray-500 dark:text-gray-400">{c.description}</div>}
                </td>
                <td className="p-3 font-mono text-xs dark:text-gray-300">{c.apiKeyPrefix}...</td>
                <td className="p-3">
                  <button onClick={() => handleToggleEnabled(c)}
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${c.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'}`}>
                    {c.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </td>
                <td className="p-3 text-gray-500 dark:text-gray-400">{formatDate(c.lastUsedAt) || '—'}</td>
                <td className="p-3 text-right">
                  <div className="flex gap-1 justify-end">
                    <button onClick={() => toggleAudit(c.id)} className="px-2 py-1 text-xs bg-gray-100 rounded hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
                      {expandedAudit === c.id ? 'Hide' : 'Log'}
                    </button>
                    <button onClick={() => handleResetKey(c)} className="px-2 py-1 text-xs bg-amber-100 text-amber-800 rounded hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50">Reset Key</button>
                    <button onClick={() => handleRemoveCrawler(c)} className="px-2 py-1 text-xs bg-red-100 text-red-800 rounded hover:bg-red-200 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40">Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
