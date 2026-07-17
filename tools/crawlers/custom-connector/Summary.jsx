import { useState, useEffect, useCallback } from 'react';
import { formatDate } from '@ui/utils/formatters';
import CopyButton from '@ui/components/CopyButton';
import { useDialog } from '@ui/components/dialogContext';

// Custom Connector's card is a CrawlerConfigs row paired with a Crawlers row
// (the API key) — see routes/crawlers.js's POST /admin/crawlers. This panel
// fetches that other row (by cfg.crawlerId) to show key prefix / enabled
// state / audit log, and to drive the enable toggle / key reset — actions
// that have no equivalent on the generic card (Run/Configure/Export are
// hidden for this type via CrawlerMeta.js's supportsRun/supportsConfigure/
// supportsExport: false). Removal still goes through the generic card's
// Remove button — the server cascades to delete this row too.
export default function Summary({ cfg, config, authFetch }) {
  const dialog = useDialog();
  const [crawler, setCrawler] = useState(null);
  const [newKey, setNewKey] = useState(null);
  const [expandedAudit, setExpandedAudit] = useState(false);
  const [auditData, setAuditData] = useState({ data: [], total: 0 });
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState(null);

  const fetchCrawler = useCallback(async () => {
    try {
      const r = await authFetch('/api/admin/crawlers');
      if (!r.ok) return;
      const all = await r.json();
      setCrawler(all.find(c => c.id === cfg.crawlerId) || null);
    } catch {}
  }, [authFetch, cfg.crawlerId]);

  useEffect(() => { fetchCrawler(); }, [fetchCrawler]);

  if (!cfg.crawlerId || !crawler) return null;

  const handleToggleEnabled = async () => {
    try {
      await authFetch(`/api/admin/crawlers/${crawler.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !crawler.enabled }),
      });
      fetchCrawler();
    } catch (err) { setError(err.message); }
  };

  const handleResetKey = async () => {
    if (!(await dialog.confirm({ message: `Reset API key for "${crawler.displayName}"?`, confirmLabel: 'Reset key', danger: true }))) return;
    setResetting(true);
    try {
      const r = await authFetch(`/api/admin/crawlers/${crawler.id}/reset`, { method: 'POST' });
      if (r.ok) { const d = await r.json(); setNewKey(d.apiKey); fetchCrawler(); }
    } catch (err) { setError(err.message); }
    finally { setResetting(false); }
  };

  const toggleAudit = async () => {
    if (expandedAudit) { setExpandedAudit(false); return; }
    try {
      const r = await authFetch(`/api/admin/crawlers/${crawler.id}/audit?limit=20`);
      if (r.ok) { setAuditData(await r.json()); setExpandedAudit(true); }
    } catch (err) { setError(err.message); }
  };

  return (
    <div className="mb-3 text-sm">
      {error && (
        <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded text-red-700 text-xs dark:bg-red-900/20 dark:border-red-700 dark:text-red-300">{error}</div>
      )}

      {newKey && (
        <div className="mb-2 p-3 bg-green-50 border border-green-200 rounded-lg dark:bg-green-900/20 dark:border-green-700">
          <div className="flex items-center justify-between mb-1">
            <span className="font-semibold text-green-800 text-xs dark:text-green-300">API Key Reset</span>
            <button onClick={() => setNewKey(null)} className="text-green-600 hover:text-green-800 text-xs dark:text-green-400 dark:hover:text-green-200">Dismiss</button>
          </div>
          <p className="text-xs text-green-700 mb-1 dark:text-green-400">Store this key securely. It will not be shown again.</p>
          <code className="block p-1.5 bg-white border border-gray-200 rounded font-mono text-xs break-all dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200">{newKey}</code>
          <CopyButton
            text={newKey}
            label="Copy key"
            className="mt-2 px-2 py-1 rounded text-xs font-medium text-green-800 dark:text-green-300 bg-white dark:bg-gray-800 border border-green-300 dark:border-green-700 hover:bg-green-100 dark:hover:bg-green-900/30"
          />
        </div>
      )}

      <div className="flex items-center gap-2 mb-2">
        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{crawler.apiKeyPrefix}...</span>
        <button onClick={handleToggleEnabled}
          className={`px-1.5 py-0.5 rounded-full text-xs font-medium ${crawler.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'}`}>
          {crawler.enabled ? 'Enabled' : 'Disabled'}
        </button>
        <span className="text-xs text-gray-500 dark:text-gray-400">Last used: {formatDate(crawler.lastUsedAt) || '—'}</span>
      </div>

      <div className="flex gap-1 mb-2">
        <button onClick={toggleAudit} className="px-2 py-1 text-xs bg-gray-100 rounded hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
          {expandedAudit ? 'Hide Log' : 'Log'}
        </button>
        <button onClick={handleResetKey} disabled={resetting}
          className="px-2 py-1 text-xs bg-amber-100 text-amber-800 rounded hover:bg-amber-200 disabled:opacity-50 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50">
          {resetting ? 'Resetting...' : 'Reset Key'}
        </button>
      </div>

      {expandedAudit && (
        <div className="border border-gray-200 rounded divide-y dark:border-gray-700 dark:divide-gray-700 max-h-48 overflow-y-auto">
          {auditData.data.length === 0 ? (
            <div className="p-2 text-xs text-gray-500 dark:text-gray-400">No activity yet.</div>
          ) : auditData.data.map((entry, i) => (
            <div key={i} className="p-2 text-xs flex items-center justify-between gap-2">
              <span className="font-mono dark:text-gray-300">{entry.action}{entry.endpoint ? ` ${entry.endpoint}` : ''}</span>
              <span className="flex-shrink-0 text-gray-500 dark:text-gray-400">{entry.statusCode} · {formatDate(entry.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
