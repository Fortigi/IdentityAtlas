import { useState } from 'react';
import { useFetch } from '@ui/hooks/useFetch';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
export default function LLMSettingsSection() {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [providers, setProviders] = useState([]);
  const [defaultModels, setDefaultModels] = useState({});
  const [config, setConfig] = useState({
    provider: 'anthropic',
    model: '',
    endpoint: '',
    deployment: '',
    apiVersion: '',
    apiKey: '',
  });
  const [apiKeySet, setApiKeySet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [message, setMessage] = useState(null);
  // Model discovery state. `models` is null until the user clicks "Refresh models"
  // (or until auto-discovery fires). `modelsLoading` gates the button.
  const [models, setModels] = useState(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(null);

  // Load the saved config + provider metadata. The editable form is seeded
  // from each fetch (re-seeding on reload after a save) via render-time
  // tracking, so we don't setState synchronously inside an effect.
  const { data: llmData, loading, reload: load } = useFetch('/api/admin/llm/config', { authFetch });
  const [seededLlm, setSeededLlm] = useState(null);
  if (llmData && llmData !== seededLlm) {
    setSeededLlm(llmData);
    setProviders(llmData.providers || []);
    setDefaultModels(llmData.defaultModels || {});
    setApiKeySet(!!llmData.apiKeySet);
    if (llmData.config) {
      setConfig(c => ({
        ...c,
        provider:   llmData.config.provider   || 'anthropic',
        model:      llmData.config.model      || '',
        endpoint:   llmData.config.endpoint   || '',
        deployment: llmData.config.deployment || '',
        apiVersion: llmData.config.apiVersion || '',
        apiKey:     '', // never returned from server
      }));
    }
  }

  const isAzure = config.provider === 'azure-openai';
  const placeholderModel = defaultModels[config.provider] || '';

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    setTestResult(null);
    try {
      const body = {
        provider:   config.provider,
        model:      config.model || null,
        endpoint:   isAzure ? (config.endpoint || null) : null,
        deployment: isAzure ? (config.deployment || null) : null,
        apiVersion: isAzure ? (config.apiVersion || null) : null,
      };
      if (config.apiKey) body.apiKey = config.apiKey;
      const r = await authFetch('/api/admin/llm/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        setMessage({ kind: 'ok', text: 'LLM settings saved' });
        setConfig(c => ({ ...c, apiKey: '' }));
        load();
      } else {
        setMessage({ kind: 'err', text: j.error || `HTTP ${r.status}` });
      }
    } finally { setSaving(false); }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setMessage(null);
    try {
      const body = {
        provider:   config.provider,
        model:      config.model || null,
        endpoint:   isAzure ? (config.endpoint || null) : null,
        deployment: isAzure ? (config.deployment || null) : null,
        apiVersion: isAzure ? (config.apiVersion || null) : null,
      };
      // If user has typed a key in the form, use it. Otherwise the server will use the saved one.
      if (config.apiKey) body.apiKey = config.apiKey;
      const r = await authFetch('/api/admin/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      setTestResult(j);
    } finally { setTesting(false); }
  };

  const handleClear = async () => {
    if (!(await dialog.confirm({ message: 'Clear the LLM configuration and stored API key?', confirmLabel: 'Clear', danger: true }))) return;
    await authFetch('/api/admin/llm/config', { method: 'DELETE' });
    setConfig({ provider: 'anthropic', model: '', endpoint: '', deployment: '', apiVersion: '', apiKey: '' });
    setApiKeySet(false);
    setModels(null);
    setMessage({ kind: 'ok', text: 'LLM configuration cleared' });
  };

  // Fetch the list of models for the current provider. Uses the typed API key
  // if present, otherwise the server falls back to the saved vault key.
  const handleRefreshModels = async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const body = { provider: config.provider };
      if (config.apiKey)    body.apiKey    = config.apiKey;
      if (config.endpoint)  body.endpoint  = config.endpoint;
      if (config.apiVersion) body.apiVersion = config.apiVersion;
      const r = await authFetch('/api/admin/llm/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.ok) {
        setModels(j.models || []);
      } else {
        setModelsError(j.error || 'Failed to fetch models');
        setModels(null);
      }
    } catch (err) {
      setModelsError(err.message);
      setModels(null);
    } finally { setModelsLoading(false); }
  };

  // Reset the discovered model list whenever the provider changes — a model
  // list for Anthropic is not valid for OpenAI. Done during render (prev-value
  // tracking) so it doesn't trip react-hooks/set-state-in-effect.
  const [seenProvider, setSeenProvider] = useState(config.provider);
  if (config.provider !== seenProvider) {
    setSeenProvider(config.provider);
    setModels(null);
    setModelsError(null);
  }

  if (loading) return <div className="text-sm text-gray-500 dark:text-gray-400 p-6">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
        <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1">LLM Provider</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Used by risk profiling, classifier generation and conversational refinement.
          The API key is encrypted at rest with envelope encryption — only the masked status is visible after saving.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Provider */}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Provider</label>
            <select
              aria-label="LLM provider"
              value={config.provider}
              onChange={e => setConfig(c => ({ ...c, provider: e.target.value }))}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-gray-200"
            >
              {providers.map(p => (
                <option key={p} value={p}>{p === 'azure-openai' ? 'Azure OpenAI' : p === 'anthropic' ? 'Anthropic Claude' : 'OpenAI'}</option>
              ))}
            </select>
          </div>

          {/* Model — dropdown after discovery, otherwise free-text input */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                {isAzure ? 'Deployment' : 'Model'}
              </label>
              <button
                type="button"
                onClick={handleRefreshModels}
                disabled={modelsLoading || (!config.apiKey && !apiKeySet)}
                className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 disabled:text-gray-400 dark:disabled:text-gray-600"
                title={(!config.apiKey && !apiKeySet) ? 'Enter an API key first' : 'Fetch available models from the provider'}
              >
                {modelsLoading ? 'Loading…' : models ? 'Refresh' : 'Discover models'}
              </button>
            </div>
            {models && models.length > 0 ? (
              <select
                value={config.model || ''}
                onChange={e => setConfig(c => ({ ...c, model: e.target.value }))}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded font-mono dark:bg-gray-700 dark:text-gray-200"
              >
                <option value="">— select a model —</option>
                {models.map(m => (
                  <option key={m.id} value={m.id}>{m.label || m.id}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={config.model}
                onChange={e => setConfig(c => ({ ...c, model: e.target.value }))}
                placeholder={placeholderModel || (isAzure ? 'e.g. gpt-4o-prod' : '')}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded font-mono dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
              />
            )}
            {modelsError && (
              <div className="text-xs text-red-600 dark:text-red-400 mt-1">Model discovery failed: {modelsError}</div>
            )}
            {models && models.length === 0 && (
              <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">No models returned — check your API key permissions.</div>
            )}
          </div>

          {/* Azure-only fields */}
          {isAzure && (
            <>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Azure endpoint</label>
                <input
                  type="text"
                  value={config.endpoint}
                  onChange={e => setConfig(c => ({ ...c, endpoint: e.target.value }))}
                  placeholder="https://my-resource.openai.azure.com"
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded font-mono dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Deployment</label>
                <input
                  type="text"
                  value={config.deployment}
                  onChange={e => setConfig(c => ({ ...c, deployment: e.target.value }))}
                  placeholder="gpt-4o-prod"
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded font-mono dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">API version</label>
                <input
                  type="text"
                  value={config.apiVersion}
                  onChange={e => setConfig(c => ({ ...c, apiVersion: e.target.value }))}
                  placeholder="2024-08-01-preview"
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded font-mono dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
                />
              </div>
            </>
          )}

          {/* API key */}
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              API key {apiKeySet && <span className="ml-2 text-green-600 dark:text-green-400">• stored</span>}
            </label>
            <input
              type="password"
              value={config.apiKey}
              onChange={e => setConfig(c => ({ ...c, apiKey: e.target.value }))}
              placeholder={apiKeySet ? '••••••••  (leave blank to keep existing)' : 'sk-...'}
              autoComplete="new-password"
              className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded font-mono dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
            />
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 disabled:text-gray-500"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={handleTest}
            disabled={testing}
            className="px-4 py-1.5 text-sm font-medium rounded border border-gray-300 dark:border-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {apiKeySet && (
            <button
              onClick={handleClear}
              className="px-4 py-1.5 text-sm font-medium rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              Clear
            </button>
          )}
        </div>

        {message && (
          <div className={`mt-3 text-sm ${message.kind === 'ok' ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
            {message.text}
          </div>
        )}
        {testResult && (
          <div className={`mt-3 text-sm rounded border p-3 ${testResult.ok ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700 text-green-800 dark:text-green-300' : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-700 text-red-800 dark:text-red-300'}`}>
            {testResult.ok ? (
              <>
                <div className="font-medium">Connection OK</div>
                <div className="text-xs mt-1">model: <code>{testResult.model}</code> · {testResult.latencyMs}ms</div>
                {testResult.sample && <div className="text-xs mt-1">sample: <code>{testResult.sample}</code></div>}
              </>
            ) : (
              <>
                <div className="font-medium">Connection failed</div>
                <div className="text-xs mt-1">{testResult.error}</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}