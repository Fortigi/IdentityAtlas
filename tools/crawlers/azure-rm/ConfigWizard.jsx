import { useState } from 'react';
import ScheduleEditor from '@ui/components/ScheduleEditor';
import Stepper from '@ui/components/Stepper';

const SECRET_PLACEHOLDER = '••••••••';

// Pure, independently-testable credential gate. The client secret is required on create but
// optional on edit (blank = keep the stored value). See credentialGating.test.js.
export function canSubmitAzureCredentials({ tenantId, clientId, clientSecret }, isEdit) {
  return !!tenantId.trim() && !!clientId.trim() && !!(clientSecret.trim() || isEdit);
}

// Parse a comma/space/newline-separated list of subscription IDs into a clean array.
export function parseSubscriptionIds(raw) {
  return (raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function AzureRmConfigWizard({ onComplete, onCancel, initialConfig, isEdit, authFetch }) {
  const [step, setStep] = useState(1);
  const [displayName, setDisplayName] = useState(initialConfig?.displayName || 'Azure Resource Manager');
  const [tenantId, setTenantId] = useState(initialConfig?.tenantId || '');
  const [clientId, setClientId] = useState(initialConfig?.clientId || '');
  const [clientSecret, setClientSecret] = useState('');

  const [managementGroupId, setManagementGroupId] = useState(initialConfig?.managementGroupId || '');
  const [subscriptionIds, setSubscriptionIds] = useState((initialConfig?.subscriptionIds || []).join(', '));
  const [includeResourceLevel, setIncludeResourceLevel] = useState(!!initialConfig?.includeResourceLevel);
  const [includeCustomRoles, setIncludeCustomRoles] = useState(
    initialConfig?.includeCustomRoles !== undefined ? !!initialConfig.includeCustomRoles : true,
  );

  const [schedules, setSchedules] = useState(initialConfig?.schedules || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const canStep1 = canSubmitAzureCredentials({ tenantId, clientId, clientSecret }, isEdit);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const config = {
        tenantId: tenantId.trim(),
        clientId: clientId.trim(),
        includeResourceLevel,
        includeCustomRoles,
      };
      if (clientSecret.trim()) config.clientSecret = clientSecret.trim();
      if (managementGroupId.trim()) config.managementGroupId = managementGroupId.trim();
      const subs = parseSubscriptionIds(subscriptionIds);
      if (subs.length) config.subscriptionIds = subs;
      if (schedules.length) config.schedules = schedules;

      let r;
      if (initialConfig?.id) {
        r = await authFetch(`/api/admin/crawler-configs/${initialConfig.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: displayName.trim(), config }),
        });
      } else {
        r = await authFetch('/api/admin/crawler-configs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ crawlerType: 'azure-rm', displayName: displayName.trim(), config }),
        });
      }
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      onComplete();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const steps = [
    { n: 1, label: 'Service Principal' },
    { n: 2, label: 'Scope & Options' },
    { n: 3, label: 'Schedule' },
  ];

  const labelCls = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
  const inputCls = 'w-full border border-gray-200 rounded px-3 py-2 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';

  return (
    <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg dark:bg-gray-800 dark:border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold dark:text-white">{isEdit ? 'Edit' : 'Add'} Azure Resource Manager Crawler</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-700 text-sm dark:text-gray-400 dark:hover:text-gray-200">Cancel</button>
      </div>

      <div className="mb-5"><Stepper steps={steps} current={step} onStepClick={setStep} allowAll={!!isEdit} /></div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-sm dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">{error}</div>}

      {/* Step 1 — Service Principal */}
      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            A service principal (app registration) with a client secret, granted the built-in <strong>Reader</strong> role
            at the management group or subscription you want crawled. Reader is sufficient — no write access is needed.
          </p>
          <div>
            <label className={labelCls}>Crawler Name</label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputCls} placeholder="Azure Resource Manager" />
          </div>
          <div>
            <label className={labelCls}>Tenant ID</label>
            <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} className={`${inputCls} font-mono`} placeholder="00000000-0000-0000-0000-000000000000" />
          </div>
          <div>
            <label className={labelCls}>Client ID</label>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} className={`${inputCls} font-mono`} placeholder="application (client) ID" />
          </div>
          <div>
            <label className={labelCls}>Client Secret</label>
            <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} className={inputCls}
              placeholder={isEdit ? SECRET_PLACEHOLDER : ''} />
            {isEdit && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Leave blank to keep the stored secret.</p>}
          </div>
          <div className="flex justify-end">
            <button onClick={() => setStep(2)} disabled={!canStep1}
              className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">Next →</button>
          </div>
        </div>
      )}

      {/* Step 2 — Scope & Options */}
      {step === 2 && (
        <div className="space-y-4">
          <div>
            <label className={labelCls}>Management Group ID <span className="text-gray-400 font-normal">(optional)</span></label>
            <input value={managementGroupId} onChange={(e) => setManagementGroupId(e.target.value)} className={`${inputCls} font-mono`} placeholder="crawl the whole hierarchy beneath this MG" />
          </div>
          <div>
            <label className={labelCls}>Subscription IDs <span className="text-gray-400 font-normal">(optional, comma-separated)</span></label>
            <input value={subscriptionIds} onChange={(e) => setSubscriptionIds(e.target.value)} className={`${inputCls} font-mono`} placeholder="leave blank to auto-discover all accessible subscriptions" />
          </div>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={includeCustomRoles} onChange={(e) => setIncludeCustomRoles(e.target.checked)} className="mt-0.5" />
            <div>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Include custom role definitions</span>
              <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">resolve tenant custom roles, not just built-in ones</span>
            </div>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={includeResourceLevel} onChange={(e) => setIncludeResourceLevel(e.target.checked)} className="mt-0.5" />
            <div>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Include individual resources</span>
              <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">enumerate every resource (high volume; off by default)</span>
            </div>
          </label>
          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className="px-4 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300">← Back</button>
            <button onClick={() => setStep(3)} className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700">Next →</button>
          </div>
        </div>
      )}

      {/* Step 3 — Schedule */}
      {step === 3 && (
        <div className="space-y-4">
          {schedules.length === 0 && (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded text-center text-sm text-gray-500 dark:bg-gray-700/50 dark:border-gray-600 dark:text-gray-400">
              No schedules configured. The crawler will only run when you click "Run".
            </div>
          )}
          {schedules.map((s, i) => (
            <ScheduleEditor key={i}
              schedule={{ enabled: true, ...s }}
              onChange={(updated) => setSchedules(schedules.map((x, idx) => (idx === i ? { ...updated, enabled: true } : x)))}
              onRemove={() => setSchedules(schedules.filter((_, idx) => idx !== i))}
            />
          ))}
          <button onClick={() => setSchedules([...schedules, { enabled: true, syncMode: 'full', frequency: 'daily', hour: 3, minute: 0 }])}
            className="px-3 py-1.5 text-xs bg-gray-200 rounded hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">+ Add Schedule</button>
          <div className="flex justify-between">
            <button onClick={() => setStep(2)} className="px-4 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300">← Back</button>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50">
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Crawler'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
