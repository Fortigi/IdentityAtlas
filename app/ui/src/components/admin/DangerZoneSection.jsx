import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { WarningIcon } from './adminIcons';
import CleanDatabasePlan, { CleanDatabaseResult } from './CleanDatabasePlan';
import { docsUrl } from '@ui/utils/docsUrl';

const BACKUP_DOCS_PATH = '/admin/backup-restore-upgrade/';

// Must match CLEAN_DATABASE_CONFIRMATION in app/api/src/routes/admin/maintenance.js.
const CLEAN_DATABASE_CONFIRMATION = 'DELETE ALL DATA';
export default function DangerZoneSection({ onRefresh, version }) {
  const { authFetch } = useAuth();
  const [confirmStep, setConfirmStep] = useState(0); // 0=idle, 1=confirm, 2=type-confirm
  const [typedConfirm, setTypedConfirm] = useState('');
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planError, setPlanError] = useState(null);

  // The dialog lists what the clean does from the API, so it cannot drift.
  const openConfirm = async () => {
    setConfirmStep(1);
    setPlanError(null);
    try {
      const r = await authFetch('/api/admin/clean-database/plan');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const lists = ['removed', 'kept', 'alsoRemoved', 'keptButChanged'];
      if (!lists.every(k => Array.isArray(data?.[k]))) throw new Error('unexpected answer');
      setPlan(data);
    } catch (err) {
      setPlanError(err.message);
    }
  };

  const handleClean = async () => {
    setCleaning(true);
    setError(null);
    try {
      // The API refuses the wipe without this explicit confirmation body.
      const r = await authFetch('/api/admin/clean-database', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: CLEAN_DATABASE_CONFIRMATION }),
      });
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
          Removes everything a crawler or plugin can recreate — systems, accounts, resources, access,
          synced and generated contexts, computed results and their history — and keeps what people made:
          settings, manual contexts and tags, uploaded lists, saved views and reports, and your decisions on
          what is kept. The next step lists exactly what goes and what stays, including the work of yours
          that goes because it hangs on removed data. Use this to re-sync from a clean slate.
        </p>

        {result && <CleanDatabaseResult result={result} onDismiss={() => setResult(null)} />}

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded">
            <div className="text-sm text-red-700 dark:text-red-300">{error}</div>
            <button onClick={() => setError(null)} className="mt-1 text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200">Dismiss</button>
          </div>
        )}

        {confirmStep === 0 && (
          <button
            onClick={openConfirm}
            className="px-4 py-2 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700"
          >
            Clean Database
          </button>
        )}

        {confirmStep === 1 && (
          <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700 rounded">
            <p className="text-sm text-yellow-900 dark:text-yellow-200 font-medium mb-2">Are you sure?</p>
            {plan && <CleanDatabasePlan plan={plan} backupUrl={docsUrl(version, BACKUP_DOCS_PATH)} />}
            {!plan && !planError && <p className="text-xs text-yellow-800 dark:text-yellow-300 mb-3">Loading what a clean removes…</p>}
            {planError && (
              <p className="text-xs text-red-700 dark:text-red-300 mb-3">
                Could not load what a clean removes ({planError}), so it cannot be confirmed.
              </p>
            )}
            <p className="text-xs text-yellow-800 dark:text-yellow-300 mb-3">
              You&apos;ll need to re-run your crawlers to populate the data again.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmStep(2)}
                disabled={!plan}
                className="px-3 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700 disabled:opacity-50"
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
              placeholder={CLEAN_DATABASE_CONFIRMATION}
              className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded mb-3 text-sm font-mono dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"
            />
            <div className="flex gap-2">
              <button
                onClick={handleClean}
                disabled={cleaning || typedConfirm !== CLEAN_DATABASE_CONFIRMATION}
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