// PROTOTYPE — Admin → LLM: which local model the report generator uses.
//
// Separate from the cloud LLM provider above it: the report generator only ever
// talks to the model server running next to Identity Atlas, so no data or
// question leaves the deployment. The list shows the models installed on that
// server; installing a model is an operator task (see tools/nl-reports/README.md).

import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';

function formatSize(bytes) {
  if (!bytes) return '';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function ReportGeneratorLLMSection() {
  const { authFetch } = useAuth();
  const { data, loading, error, reload } = useFetch('/api/admin/nl-reports/config', { authFetch });
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const model = selected ?? data?.model ?? '';
  const models = data?.models || [];
  const installed = models.some(m => m.name === data?.model);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await authFetch('/api/admin/nl-reports/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setMessage({ kind: 'ok', text: `Report generator now uses ${body.model}` });
      setSelected(null);
      reload();
    } catch (e) {
      setMessage({ kind: 'err', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
      <h3 className="mb-1 text-base font-semibold text-gray-900 dark:text-white">
        Local LLM for report generator
        <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 align-middle text-xs font-medium text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">prototype</span>
      </h3>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Turns a report described in plain language into a report definition. It runs on a model server next to
        Identity Atlas — questions never leave this deployment, and the model never sees your data.
      </p>

      {loading && <p className="text-sm text-gray-600 dark:text-gray-400">Loading…</p>}
      {error && <p className="text-sm text-red-700 dark:text-red-300">Could not load the report generator settings: {error.message}</p>}

      {data && !data.reachable && (
        <p className="text-sm text-red-700 dark:text-red-300">
          The local model server is not reachable. Reports can still be built by hand; describing them in plain language is unavailable.
        </p>
      )}

      {data?.reachable && (
        <div className="space-y-3">
          {!installed && (
            <p className="text-sm text-amber-800 dark:text-amber-300">
              The configured model “{data.model}” is not installed on the model server. Pick one of the installed models.
            </p>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="report-llm-model" className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">Model</label>
              <select id="report-llm-model" value={model} onChange={e => setSelected(e.target.value)}
                className="min-w-72 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
                {!installed && <option value={data.model}>{data.model} (not installed)</option>}
                {models.map(m => (
                  <option key={m.name} value={m.name}>
                    {m.name} — {m.parameterSize}, {formatSize(m.sizeBytes)}{m.loaded ? ', loaded' : ''}
                  </option>
                ))}
              </select>
            </div>
            <button type="button" onClick={save} disabled={saving || model === data.model || !models.some(m => m.name === model)}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600">
              {saving ? 'Saving…' : 'Save'}
            </button>
            {message && (
              <span role="status" className={message.kind === 'ok' ? 'text-sm text-green-700 dark:text-green-300' : 'text-sm text-red-700 dark:text-red-300'}>{message.text}</span>
            )}
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            In our tests on a 4-CPU server, qwen2.5-coder:3b was both the most accurate and the fastest (~5 s per question once warm).
            Larger models need more memory (roughly the size shown plus 1 GB) and answer more slowly on CPU.
          </p>
        </div>
      )}
    </div>
  );
}
