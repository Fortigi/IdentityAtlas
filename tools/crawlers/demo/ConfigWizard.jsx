import { useState } from 'react';
import WizardShell from '@ui/components/WizardShell';

// The demo job runs with an inline config, so the body is the whole contract.
// Extracted from the component so the "off means no key at all" rule — which
// keeps an ordinary demo import byte-identical to what it has always been — is
// unit-testable without rendering anything.
export function buildDemoJobPayload(includeVolumeData) {
  return includeVolumeData
    ? { jobType: 'demo', config: { includeVolumeData: true } }
    : { jobType: 'demo' };
}

export default function DemoConfigWizard({ onComplete, onCancel, authFetch }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [includeVolumeData, setIncludeVolumeData] = useState(false);

  const handleLoad = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/crawler-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildDemoJobPayload(includeVolumeData)),
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
    <WizardShell title="Load Demo Data" onCancel={onCancel} cancelDisabled={loading} error={error}>
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

      <div className="mb-5">
        <label htmlFor="demo-include-volume" className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
          <input
            id="demo-include-volume"
            type="checkbox"
            checked={includeVolumeData}
            onChange={(e) => setIncludeVolumeData(e.target.checked)}
            disabled={loading}
            className="mt-0.5"
          />
          <span>
            Also load high-cardinality test data
            <span className="block text-xs text-gray-600 dark:text-gray-400">
              Adds ~520 extra groups, each with its own description, so filter and attribute
              dropdowns hold more values than they can list at once. For testing that behaviour —
              leave off for a normal demo.
            </span>
          </span>
        </label>
      </div>

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
    </WizardShell>
  );
}
