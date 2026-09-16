// API key input. When a key is already stored the label shows a "• stored" badge
// and the field placeholder hints that leaving it blank keeps the existing key.
export default function LLMApiKeyField({ apiKey, apiKeySet, onChange }) {
  return (
    <div className="sm:col-span-2">
      <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
        API key {apiKeySet && <span className="ml-2 text-green-600 dark:text-green-400">• stored</span>}
      </label>
      <input
        type="password"
        value={apiKey}
        onChange={e => onChange(e.target.value)}
        placeholder={apiKeySet ? '••••••••  (leave blank to keep existing)' : 'sk-...'}
        autoComplete="new-password"
        className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded font-mono dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
      />
    </div>
  );
}
