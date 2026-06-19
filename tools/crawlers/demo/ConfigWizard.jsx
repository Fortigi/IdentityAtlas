import { useState } from 'react';

export default function DemoConfigWizard({ onComplete, onCancel, authFetch }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleLoad = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/crawler-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobType: 'demo' }),
      });
      if (!r.ok) {
        const e = await r.json();
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      onComplete();
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg dark:bg-gray-800 dark:border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Load Demo Data</h3>
        <button
          onClick={onCancel}
          disabled={loading}
          className="text-gray-500 hover:text-gray-700 text-sm dark:text-gray-400 dark:hover:text-gray-200"
        >
          Cancel
        </button>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        Loads a synthetic dataset so you can explore the platform without connecting a live system.
        The import takes approximately 30 seconds.
      </p>

      <div className="mb-5 p-4 bg-gray-50 border border-gray-200 rounded-lg dark:bg-gray-700/50 dark:border-gray-600">
        <p className="text-xs font-medium text-gray-700 dark:text-gray-200 mb-2 uppercase tracking-wide">What gets imported</p>
        <ul className="text-sm text-gray-600 dark:text-gray-300 space-y-1 list-disc pl-4">
          <li>Sample users, identities, and org-unit hierarchy</li>
          <li>Entra ID groups and access packages with role assignments</li>
          <li>Application roles and delegated permissions</li>
          <li>Business roles with governed assignments</li>
        </ul>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={handleLoad}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Starting…' : 'Load Demo Data'}
        </button>
        <button
          onClick={onCancel}
          disabled={loading}
          className="px-4 py-2 bg-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
