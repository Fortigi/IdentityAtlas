import { useState } from 'react';
import { useFetch } from '@ui/hooks/useFetch';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import { buildConfigBody, seedConfig } from './LLMSettingsSection.helpers';
import LLMProviderField from './LLMProviderField';
import LLMModelField from './LLMModelField';
import LLMAzureFields from './LLMAzureFields';
import LLMApiKeyField from './LLMApiKeyField';
import LLMActionButtons from './LLMActionButtons';
import LLMStatusMessages from './LLMStatusMessages';

const EMPTY_CONFIG = { provider: 'anthropic', model: '', endpoint: '', deployment: '', apiVersion: '', apiKey: '' };

export default function LLMSettingsSection() {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [providers, setProviders] = useState([]);
  const [defaultModels, setDefaultModels] = useState({});
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [message, setMessage] = useState(null);
  // Model discovery state. `models` is null until the user clicks "Discover
  // models" (or until auto-discovery fires). `modelsLoading` gates the button.
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
    if (llmData.config) setConfig(c => seedConfig(c, llmData.config));
  }

  const isAzure = config.provider === 'azure-openai';
  const placeholderModel = defaultModels[config.provider] || '';
  const apiKeyAvailable = !!(config.apiKey || apiKeySet);
  const updateConfig = (field, value) => setConfig(c => ({ ...c, [field]: value }));

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    setTestResult(null);
    try {
      const body = buildConfigBody(config, isAzure);
      if (config.apiKey) body.apiKey = config.apiKey;
      const r = await authFetch('/api/admin/llm/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        setMessage({ kind: 'ok', text: 'LLM settings saved' });
        updateConfig('apiKey', '');
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
      const body = buildConfigBody(config, isAzure);
      // If user has typed a key in the form, use it. Otherwise the server will use the saved one.
      if (config.apiKey) body.apiKey = config.apiKey;
      const r = await authFetch('/api/admin/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setTestResult(await r.json());
    } finally { setTesting(false); }
  };

  const handleClear = async () => {
    if (!(await dialog.confirm({ message: 'Clear the LLM configuration and stored API key?', confirmLabel: 'Clear', danger: true }))) return;
    await authFetch('/api/admin/llm/config', { method: 'DELETE' });
    setConfig(EMPTY_CONFIG);
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
          <LLMProviderField
            provider={config.provider}
            providers={providers}
            onChange={v => updateConfig('provider', v)}
          />
          <LLMModelField
            isAzure={isAzure}
            models={models}
            modelsLoading={modelsLoading}
            modelsError={modelsError}
            model={config.model}
            placeholderModel={placeholderModel}
            apiKeyAvailable={apiKeyAvailable}
            onRefresh={handleRefreshModels}
            onModelChange={v => updateConfig('model', v)}
          />
          {isAzure && (
            <LLMAzureFields
              endpoint={config.endpoint}
              deployment={config.deployment}
              apiVersion={config.apiVersion}
              onField={updateConfig}
            />
          )}
          <LLMApiKeyField
            apiKey={config.apiKey}
            apiKeySet={apiKeySet}
            onChange={v => updateConfig('apiKey', v)}
          />
        </div>

        <LLMActionButtons
          saving={saving}
          testing={testing}
          apiKeySet={apiKeySet}
          onSave={handleSave}
          onTest={handleTest}
          onClear={handleClear}
        />

        <LLMStatusMessages message={message} testResult={testResult} />
      </div>
    </div>
  );
}
