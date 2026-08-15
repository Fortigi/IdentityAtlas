// Save / Test / Clear button row for the LLM settings form. The Clear button
// only appears once a key is stored.
export default function LLMActionButtons({ saving, testing, apiKeySet, onSave, onTest, onClear }) {
  return (
    <div className="mt-4 flex gap-2">
      <button
        onClick={onSave}
        disabled={saving}
        className="px-4 py-1.5 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 disabled:text-gray-500"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button
        onClick={onTest}
        disabled={testing}
        className="px-4 py-1.5 text-sm font-medium rounded border border-gray-300 dark:border-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
      >
        {testing ? 'Testing…' : 'Test connection'}
      </button>
      {apiKeySet && (
        <button
          onClick={onClear}
          className="px-4 py-1.5 text-sm font-medium rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
        >
          Clear
        </button>
      )}
    </div>
  );
}
