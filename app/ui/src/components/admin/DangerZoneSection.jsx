import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { WarningIcon } from './adminIcons';
export default function DangerZoneSection({ onRefresh }) {
  const { authFetch } = useAuth();
  const [confirmStep, setConfirmStep] = useState(0); // 0=idle, 1=confirm, 2=type-confirm
  const [typedConfirm, setTypedConfirm] = useState('');
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleClean = async () => {
    setCleaning(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/clean-database', { method: 'POST' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setResult(data);
      setConfirmStep(0);
      setTypedConfirm('');
      onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-red-200 dark:border-red-800 overflow-hidden">
      <div className="px-5 py-4 border-b border-red-100 dark:border-red-800 bg-red-50 dark:bg-red-900/20">
        <div className="flex items-center gap-3">
          <WarningIcon className="w-5 h-5 text-red-600 dark:text-red-400" />
          <span className="font-medium text-red-900 dark:text-red-300">Danger Zone</span>
        </div>
      </div>
      <div className="p-5">
        <h4 className="font-semibold text-gray-900 dark:text-white mb-1">Clean Database</h4>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Wipes all identity data (users, groups, assignments, identities, governance, sync log) but
          preserves crawler configurations, risk profiles, and correlation rules. Use this when you want
          to re-sync from a clean slate without re-creating your crawler setup.
        </p>

        {result && (
          <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded">
            <div className="font-medium text-green-800 dark:text-green-300 text-sm mb-2">Database cleaned</div>
            <div className="text-xs text-green-700 dark:text-green-400">
              Wiped {result.wiped?.length || 0} table{result.wiped?.length !== 1 ? 's' : ''}
              {result.skipped?.length > 0 && ` (${result.skipped.length} skipped)`}
            </div>
            {result.wiped?.length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-green-700 dark:text-green-400 cursor-pointer hover:underline">Show details</summary>
                <ul className="mt-1 text-xs text-green-600 dark:text-green-400 space-y-0.5">
                  {result.wiped.map(w => (
                    <li key={w.table}>
                      <code>{w.table}</code>: {w.rowsAffected} rows{w.temporal ? ' (temporal)' : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <button onClick={() => setResult(null)} className="mt-2 text-xs text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-200">Dismiss</button>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded">
            <div className="text-sm text-red-700 dark:text-red-300">{error}</div>
            <button onClick={() => setError(null)} className="mt-1 text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200">Dismiss</button>
          </div>
        )}

        {confirmStep === 0 && (
          <button
            onClick={() => setConfirmStep(1)}
            className="px-4 py-2 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700"
          >
            Clean Database
          </button>
        )}

        {confirmStep === 1 && (
          <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700 rounded">
            <p className="text-sm text-yellow-900 dark:text-yellow-200 font-medium mb-2">Are you sure?</p>
            <p className="text-xs text-yellow-800 dark:text-yellow-300 mb-3">
              This will delete all identity data. Crawler configurations and risk profiles will be kept.
              You'll need to re-run your crawlers to populate the data again.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmStep(2)}
                className="px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700"
              >
                Yes, continue
              </button>
              <button
                onClick={() => setConfirmStep(0)}
                className="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {confirmStep === 2 && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-700 rounded">
            <p className="text-sm text-red-900 dark:text-red-200 font-medium mb-2">Final confirmation</p>
            <p className="text-xs text-red-800 dark:text-red-300 mb-3">
              Type <code className="px-1 bg-red-100 dark:bg-red-900/40 rounded">DELETE ALL DATA</code> to confirm:
            </p>
            <input
              type="text"
              value={typedConfirm}
              onChange={e => setTypedConfirm(e.target.value)}
              placeholder="DELETE ALL DATA"
              className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded mb-3 text-sm font-mono dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
            />
            <div className="flex gap-2">
              <button
                onClick={handleClean}
                disabled={cleaning || typedConfirm !== 'DELETE ALL DATA'}
                className="px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700 disabled:opacity-50"
              >
                {cleaning ? 'Cleaning...' : 'Clean Database'}
              </button>
              <button
                onClick={() => { setConfirmStep(0); setTypedConfirm(''); }}
                className="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}