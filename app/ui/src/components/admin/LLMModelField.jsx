// Model / Deployment picker — a discovered-model dropdown once the provider has
// returned a list, otherwise a free-text input. The "Discover models" button
// fetches the list; discovery errors and empty results render below.
export default function LLMModelField({
  isAzure,
  models,
  modelsLoading,
  modelsError,
  model,
  placeholderModel,
  apiKeyAvailable,
  onRefresh,
  onModelChange,
}) {
  const buttonLabel = modelsLoading ? 'Loading…' : models ? 'Refresh' : 'Discover models';
  const placeholder = placeholderModel || (isAzure ? 'e.g. gpt-4o-prod' : '');
  const inputClass =
    'w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded font-mono dark:bg-gray-700 dark:text-gray-200';

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
          {isAzure ? 'Deployment' : 'Model'}
        </label>
        <button
          type="button"
          onClick={onRefresh}
          disabled={modelsLoading || !apiKeyAvailable}
          className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 disabled:text-gray-400 dark:disabled:text-gray-600"
          title={apiKeyAvailable ? 'Fetch available models from the provider' : 'Enter an API key first'}
        >
          {buttonLabel}
        </button>
      </div>
      {models && models.length > 0 ? (
        <select
          value={model || ''}
          onChange={e => onModelChange(e.target.value)}
          className={inputClass}
        >
          <option value="">— select a model —</option>
          {models.map(m => (
            <option key={m.id} value={m.id}>{m.label || m.id}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={model}
          onChange={e => onModelChange(e.target.value)}
          placeholder={placeholder}
          className={`${inputClass} dark:placeholder-gray-500`}
        />
      )}
      {modelsError && (
        <div className="text-xs text-red-600 dark:text-red-400 mt-1">Model discovery failed: {modelsError}</div>
      )}
      {models && models.length === 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">No models returned — check your API key permissions.</div>
      )}
    </div>
  );
}
