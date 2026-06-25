import { useState } from 'react';
import ScheduleEditor from '@ui/components/ScheduleEditor';
import WizardShell from '@ui/components/WizardShell';
import { SECRET_PLACEHOLDER } from '@ui/utils/crawlerCredentials';

// Pure, independently-testable credential gate. The client secret is required on create but
// optional on edit (blank = keep the stored value). See credentialGating.test.js.
export function canSubmitAzureCredentials({ tenantId, clientId, clientSecret }, isEdit) {
  return !!tenantId.trim() && !!clientId.trim() && !!(clientSecret.trim() || isEdit);
}

// Parse a comma/space/newline-separated list of subscription IDs into a clean array.
// Used for the manual fallback when live discovery can't reach Azure.
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

  const [scopeMode, setScopeMode] = useState(initialConfig?.managementGroupId ? 'mg' : 'subscriptions');
  const [managementGroupId, setManagementGroupId] = useState(initialConfig?.managementGroupId || '');
  const [selectedSubs, setSelectedSubs] = useState(initialConfig?.subscriptionIds || []);
  const [manualSubs, setManualSubs] = useState((initialConfig?.subscriptionIds || []).join(', '));
  const [includeResourceLevel, setIncludeResourceLevel] = useState(!!initialConfig?.includeResourceLevel);
  const [includeCustomRoles, setIncludeCustomRoles] = useState(
    initialConfig?.includeCustomRoles !== undefined ? !!initialConfig.includeCustomRoles : true,
  );
  const [onlyEntraPrincipals, setOnlyEntraPrincipals] = useState(
    initialConfig?.onlyEntraPrincipals !== undefined ? !!initialConfig.onlyEntraPrincipals : true,
  );

  // Live discovery (subscriptions + nested management groups)
  const [availableSubs, setAvailableSubs] = useState([]);
  const [availableMGs, setAvailableMGs] = useState([]);
  const [scopeLoaded, setScopeLoaded] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState(null);

  const [schedules, setSchedules] = useState(initialConfig?.schedules || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const canStep1 = canSubmitAzureCredentials({ tenantId, clientId, clientSecret }, isEdit);

  const fetchScope = async (force = false) => {
    if ((scopeLoaded && !force) || discovering) return;
    setDiscovering(true);
    setDiscoverError(null);
    try {
      // On edit without a freshly-typed secret, let the server use the stored one.
      const body = initialConfig?.id && !clientSecret.trim()
        ? { configId: initialConfig.id }
        : { config: { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() } };
      const r = await authFetch('/api/admin/crawlers/azure-rm/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setAvailableSubs(d.subscriptions || []);
      setAvailableMGs(d.managementGroups || []);
      setScopeLoaded(true);
    } catch (err) {
      setDiscoverError(err.message);
    } finally {
      setDiscovering(false);
    }
  };

  const goToStep = (n) => { setStep(n); if (n === 2) fetchScope(); };
  const toggleSub = (id) =>
    setSelectedSubs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const config = {
        tenantId: tenantId.trim(),
        clientId: clientId.trim(),
        includeResourceLevel,
        includeCustomRoles,
        onlyEntraPrincipals,
      };
      if (clientSecret.trim()) config.clientSecret = clientSecret.trim();
      // The two scope modes are mutually exclusive. Always send both keys (one
      // cleared) so a PATCH merge can't leave a stale value from the other mode.
      if (scopeMode === 'mg') {
        config.managementGroupId = managementGroupId;
        config.subscriptionIds = [];
      } else {
        config.managementGroupId = '';
        // Selected from the discovered list, or parsed from the manual fallback.
        config.subscriptionIds = availableSubs.length ? selectedSubs : parseSubscriptionIds(manualSubs);
      }
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
    <WizardShell
      title={`${isEdit ? 'Edit' : 'Add'} Azure Resource Manager Crawler`}
      onCancel={onCancel}
      steps={steps}
      currentStep={step}
      onStepClick={goToStep}
      allowAllSteps={isEdit}
      error={error}
    >

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
            <button onClick={() => goToStep(2)} disabled={!canStep1}
              className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">Next →</button>
          </div>
        </div>
      )}

      {/* Step 2 — Scope & Options */}
      {step === 2 && (
        <div className="space-y-5">
          {/* Scope mode toggle */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={labelCls + ' mb-0'}>What should this crawler cover?</label>
              <button onClick={() => fetchScope(true)} disabled={discovering}
                className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50">
                {discovering ? 'Loading…' : '↻ Refresh'}
              </button>
            </div>
            <div className="flex gap-2">
              <button type="button"
                onClick={() => setScopeMode('subscriptions')}
                className={`flex-1 px-3 py-2 text-sm rounded border transition-colors ${
                  scopeMode === 'subscriptions'
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-gray-600 dark:text-gray-400'
                }`}>Specific subscriptions</button>
              <button type="button"
                onClick={() => { setScopeMode('mg'); if (!managementGroupId && availableMGs[0]) setManagementGroupId(availableMGs[0].name); }}
                className={`flex-1 px-3 py-2 text-sm rounded border transition-colors ${
                  scopeMode === 'mg'
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-gray-600 dark:text-gray-400'
                }`}>A management group</button>
            </div>
          </div>

          {discovering && <p className="text-xs text-gray-500 dark:text-gray-400 italic">Discovering subscriptions and management groups…</p>}
          {discoverError && (
            <p className="text-xs text-amber-600 dark:text-amber-400">Live discovery unavailable ({discoverError}). You can still enter subscription IDs manually below.</p>
          )}

          {/* Subscriptions (checkable) */}
          {scopeMode === 'subscriptions' && (
            <div>
              <label className={labelCls}>Subscriptions</label>
              {availableSubs.length > 0 ? (
                <div className="space-y-1 max-h-56 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded p-2">
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Leave all unchecked to crawl every accessible subscription.</p>
                  {availableSubs.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 cursor-pointer text-sm text-gray-700 dark:text-gray-300">
                      <input type="checkbox" checked={selectedSubs.includes(s.id)} onChange={() => toggleSub(s.id)} />
                      <span>{s.name} <span className="text-xs text-gray-400 font-mono">{s.id}</span></span>
                    </label>
                  ))}
                </div>
              ) : (
                <input value={manualSubs} onChange={(e) => setManualSubs(e.target.value)} className={`${inputCls} font-mono`}
                  placeholder="comma-separated subscription IDs — or leave blank for all accessible subscriptions" />
              )}
            </div>
          )}

          {/* Management groups (nested) */}
          {scopeMode === 'mg' && (
            <div>
              <label className={labelCls}>Management Group <span className="text-gray-400 font-normal">(crawls the whole subtree)</span></label>
              {availableMGs.length > 0 ? (
                <div className="space-y-1 max-h-48 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded p-2">
                  {availableMGs.map((mg) => (
                    <label key={mg.name} className="flex items-center gap-2 cursor-pointer text-sm text-gray-700 dark:text-gray-300"
                      style={{ paddingLeft: `${mg.depth * 1.25}rem` }}>
                      <input type="radio" name="mg" checked={managementGroupId === mg.name} onChange={() => setManagementGroupId(mg.name)} />
                      <span>{mg.displayName} <span className="text-xs text-gray-400 font-mono">{mg.name}</span></span>
                    </label>
                  ))}
                </div>
              ) : (
                <input value={managementGroupId} onChange={(e) => setManagementGroupId(e.target.value)} className={`${inputCls} font-mono`}
                  placeholder="management group ID" />
              )}
            </div>
          )}

          {/* Options */}
          <div className="space-y-2 border-t border-gray-200 dark:border-gray-700 pt-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={onlyEntraPrincipals} onChange={(e) => setOnlyEntraPrincipals(e.target.checked)} className="mt-0.5" />
              <div>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Only load assignments for principals in Entra ID</span>
                <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">skip role assignments whose principal isn&apos;t in the directory (run the Entra ID crawler first). Off: load them but flag the principal as orphaned</span>
              </div>
            </label>
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
          </div>

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
    </WizardShell>
  );
}
