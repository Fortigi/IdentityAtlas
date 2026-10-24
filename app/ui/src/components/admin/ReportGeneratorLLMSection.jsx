// PROTOTYPE — Admin → LLM: status of the local model behind the report generator.
//
// Separate from the cloud LLM provider above it: the report generator only talks to
// the model server running next to Identity Atlas, so no question or data leaves the
// deployment. The model is chosen per release — there is nothing to pick here.

import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';

export default function ReportGeneratorLLMSection() {
  const { authFetch } = useAuth();
  const { data, loading, error, reload } = useFetch('/api/admin/nl-reports/config', { authFetch });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await authFetch('/api/nl-reports/warm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.state === 'preparing') {
        setResult({ kind: 'ok', text: body.message });
        return;
      }
      setResult({
        kind: 'ok',
        text: body.restored === false
          ? `Ready in ${(body.ms / 1000).toFixed(0)} s — the prompt was read and saved; the next cold start restores it.`
          : `Ready in ${(body.ms / 1000).toFixed(1)} s${body.restored ? ' (saved prompt restored)' : ''}.`,
      });
      reload();
    } catch (e) {
      setResult({ kind: 'err', text: e.message });
    } finally {
      setTesting(false);
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
      {error && <p className="text-sm text-red-700 dark:text-red-300">Could not load the report generator status: {error.message}</p>}

      {data && (
        <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-gray-600 dark:text-gray-400">Status</dt>
          <dd className={data.reachable ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}>
            {data.reachable ? 'Model server reachable' : 'Model server not reachable — reports can still be built by hand'}
          </dd>
          <dt className="text-gray-600 dark:text-gray-400">Model</dt>
          <dd className="text-gray-900 dark:text-gray-100">
            {data.model || '—'}
            {data.fixed && <span className="ml-2 text-xs text-gray-600 dark:text-gray-400">chosen by this release</span>}
          </dd>
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={test} disabled={testing || !data?.reachable}
          className="rounded bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
          {testing ? 'Testing…' : 'Test'}
        </button>
        {result && (
          <span role="status" className={result.kind === 'ok' ? 'text-sm text-green-700 dark:text-green-300' : 'text-sm text-red-700 dark:text-red-300'}>
            {result.text}
          </span>
        )}
      </div>
    </div>
  );
}
