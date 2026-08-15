// Full-screen fallback shown when the matrix data fetch can't reach the backend.
export default function BackendErrorScreen({ error }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-6 max-w-md">
        <h2 className="text-red-800 dark:text-red-300 font-semibold text-lg">Backend not responding</h2>
        <p className="text-red-600 dark:text-red-400 mt-2 text-sm">{error}</p>
        <p className="text-red-500 dark:text-red-400 mt-2 text-xs">
          If a crawler is currently running, this page may be temporarily slow — wait a moment and refresh.
          Otherwise check that the web container is running: <code className="bg-red-100 dark:bg-red-900 px-1 rounded">docker compose ps web</code> · <code className="bg-red-100 dark:bg-red-900 px-1 rounded">docker compose logs web</code>
        </p>
      </div>
    </div>
  );
}
