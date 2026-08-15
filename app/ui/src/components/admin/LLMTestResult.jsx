// Result panel for a "Test connection" attempt — green on success (with model,
// latency and an optional sample), red with the error otherwise.
export default function LLMTestResult({ result }) {
  const base = 'mt-3 text-sm rounded border p-3 ';
  if (!result.ok) {
    return (
      <div className={`${base}bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-700 text-red-800 dark:text-red-300`}>
        <div className="font-medium">Connection failed</div>
        <div className="text-xs mt-1">{result.error}</div>
      </div>
    );
  }
  return (
    <div className={`${base}bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700 text-green-800 dark:text-green-300`}>
      <div className="font-medium">Connection OK</div>
      <div className="text-xs mt-1">model: <code>{result.model}</code> · {result.latencyMs}ms</div>
      {result.sample && <div className="text-xs mt-1">sample: <code>{result.sample}</code></div>}
    </div>
  );
}
