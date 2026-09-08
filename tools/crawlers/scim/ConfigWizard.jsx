import { useState } from 'react';
import ScheduleEditor from '@ui/components/ScheduleEditor';
import MappingRows from '@ui/components/MappingRows';
import WizardShell from '@ui/components/WizardShell';
import Combobox from '@ui/components/inputs/Combobox';
import Select from '@ui/components/inputs/Select';
import { SECRET_PLACEHOLDER, canSubmitCredentials, buildCredentialFields } from '@ui/utils/crawlerCredentials';

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTH_METHODS = [
  { id: 'BasicAuth', label: 'HTTP Basic Auth',           description: 'username + password (Authorization: Basic)' },
  { id: 'ApiToken',  label: 'API Token',                 description: 'static bearer token' },
  { id: 'OAuth2CC',  label: 'OAuth2 Client Credentials', description: 'service-to-service bearer token' },
];

const SYNC_OPTIONS = [
  { key: 'users',        label: 'Users',         description: 'SCIM /Users → principals' },
  { key: 'groups',       label: 'Groups',        description: 'SCIM /Groups → group resources' },
  { key: 'groupMembers', label: 'Group members', description: 'Memberships, including nested groups' },
];

const PRINCIPAL_TYPE_OPTIONS = ['User', 'ServicePrincipal', 'ManagedIdentity', 'WorkloadIdentity', 'AIAgent', 'ExternalUser', 'SharedMailbox'];
const FIELD_CLS = 'text-sm border border-gray-300 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
const EMPTY_DISCOVERY = { resourceTypes: [], userAttributes: [], groupAttributes: [] };

// ─── Pure logic (exported for unit tests) ────────────────────────────────────

// The attribute picker is OPT-IN: it starts empty and a click toggles one
// attribute. Returns a NEW array so React sees the change.
export function toggleAttribute(selected, name) {
  const current = Array.isArray(selected) ? selected : [];
  return current.includes(name) ? current.filter(a => a !== name) : [...current, name];
}

// "Select all" is a toggle, not a one-way switch: when everything discovered is
// already selected it clears the list instead of re-selecting it, so the same
// control undoes itself.
export function toggleAllAttributes(selected, available) {
  const current = Array.isArray(selected) ? selected : [];
  const all = Array.isArray(available) ? available : [];
  const allSelected = all.length > 0 && all.every(a => current.includes(a));
  if (allSelected) return current.filter(a => !all.includes(a));
  return [...new Set([...current, ...all])];
}

// A crawler that syncs nothing would run, report success and quietly delete every
// row it previously wrote, so at least one object type has to be on.
export function canSubmitObjects(selectedObjects) {
  return !!(selectedObjects && (selectedObjects.users || selectedObjects.groups));
}

// Build the saved config blob. Credentials are merged in by the caller via
// buildCredentialFields so a blank secret keeps the stored value on edit.
export function buildScimConfig({ baseUrl, authMethod, systemName, pageSize, selectedObjects, userAttributes, groupAttributes, userTypeMapping, scope, schedules }) {
  const config = {
    baseUrl: (baseUrl || '').trim().replace(/\/+$/, ''),
    authMethod,
    systemName: (systemName || '').trim() || 'SCIM',
    pageSize: parseInt(pageSize, 10) || 100,
    selectedObjects: {
      users: !!selectedObjects?.users,
      groups: !!selectedObjects?.groups,
      groupMembers: !!selectedObjects?.groupMembers,
    },
    selectedAttributes: {
      user: [...(userAttributes || [])],
      group: [...(groupAttributes || [])],
    },
    userTypeMapping: (userTypeMapping || []).map(m => ({
      userType: (m.userType || '').trim(),
      principalType: m.principalType || 'User',
    })),
  };
  if (scope && scope.trim()) config.scope = scope.trim();
  if (schedules && schedules.length) config.schedules = schedules;
  return config;
}

// ─── Wizard ───────────────────────────────────────────────────────────────────

export default function ScimConfigWizard({ onComplete, onCancel, initialConfig, isEdit, authFetch }) {
  const [step, setStep] = useState(1);
  const [displayName, setDisplayName] = useState(initialConfig?.displayName || 'SCIM 2.0');
  const [baseUrl, setBaseUrl]         = useState(initialConfig?.baseUrl || '');
  const [systemName, setSystemName]   = useState(initialConfig?.systemName || '');
  const [authMethod, setAuthMethod]   = useState(initialConfig?.authMethod || 'BasicAuth');

  // Credential fields (secrets start blank; blank = keep stored value in edit mode)
  const [username, setUsername]           = useState(initialConfig?.username || '');
  const [password, setPassword]           = useState('');
  const [apiToken, setApiToken]           = useState('');
  const [clientId, setClientId]           = useState(initialConfig?.clientId || '');
  const [clientSecret, setClientSecret]   = useState('');
  const [tokenEndpoint, setTokenEndpoint] = useState(initialConfig?.tokenEndpoint || '');
  const [scope, setScope]                 = useState(initialConfig?.scope || '');

  const [selectedObjects, setSelectedObjects] = useState({
    users: true, groups: true, groupMembers: true, ...(initialConfig?.selectedObjects || {}),
  });
  const [pageSize, setPageSize] = useState(initialConfig?.pageSize || 100);

  // Opt-in attribute picker — empty unless the operator (or a saved config) chose.
  const [userAttributes, setUserAttributes]   = useState(initialConfig?.selectedAttributes?.user || []);
  const [groupAttributes, setGroupAttributes] = useState(initialConfig?.selectedAttributes?.group || []);

  const [typeMapping, setTypeMapping] = useState(
    initialConfig?.userTypeMapping?.length
      ? initialConfig.userTypeMapping.map(m => ({ userType: m.userType || '', principalType: m.principalType || 'User' }))
      : [{ userType: '', principalType: 'User' }]
  );
  const addMap = () => setTypeMapping(p => [...p, { userType: '', principalType: 'User' }]);
  const rmMap  = i => setTypeMapping(p => p.filter((_, idx) => idx !== i));
  const upMap  = (i, f, v) => setTypeMapping(p => p.map((e, idx) => idx === i ? { ...e, [f]: v } : e));

  const [disco, setDisco] = useState(null);
  const [discoLoading, setDiscoLoading] = useState(false);
  const [discoError, setDiscoError] = useState(null);

  const fetchDiscovery = async ({ force = false } = {}) => {
    if (discoLoading || (disco !== null && !force)) return;
    setDiscoLoading(true); setDiscoError(null);
    try {
      const body = initialConfig?.id
        ? { configId: initialConfig.id }
        : { config: { baseUrl: baseUrl.trim(), authMethod, username: username.trim(), password: password.trim(),
                      apiToken: apiToken.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim(),
                      tokenEndpoint: tokenEndpoint.trim(), scope: scope.trim() } };
      const r = await authFetch('/api/admin/crawlers/scim/discover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (r.ok) {
        setDisco(await r.json());
      } else {
        const e = await r.json().catch(() => ({}));
        setDisco(EMPTY_DISCOVERY);
        setDiscoError(e.error || 'Could not reach the SCIM endpoint — check the base URL and credentials');
      }
    } catch {
      setDisco(EMPTY_DISCOVERY);
      setDiscoError('Discovery failed — check the base URL and credentials');
    } finally { setDiscoLoading(false); }
  };

  const [schedules, setSchedules] = useState(initialConfig?.schedules || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const canStep1 = !!(displayName.trim() && baseUrl.trim());
  const credentialFields = { username, password, clientId, clientSecret, tokenEndpoint, apiToken };
  const canStep2 = canSubmitCredentials(authMethod, credentialFields, isEdit);
  const canStep3 = canSubmitObjects(selectedObjects);

  const handleSave = async () => {
    setSaving(true); setError(null);
    try {
      const configPayload = buildScimConfig({
        baseUrl, authMethod, systemName, pageSize, selectedObjects,
        userAttributes, groupAttributes, userTypeMapping: typeMapping, scope, schedules,
      });
      Object.assign(configPayload, buildCredentialFields(authMethod, credentialFields));

      const r = initialConfig?.id
        ? await authFetch(`/api/admin/crawler-configs/${initialConfig.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName: displayName.trim(), config: configPayload }),
          })
        : await authFetch('/api/admin/crawler-configs', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ crawlerType: 'scim', displayName: displayName.trim(), config: configPayload }),
          });
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

  const inputCls = 'w-full border border-gray-200 rounded px-3 py-2 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
  const monoCls  = inputCls + ' font-mono';
  const nextCls  = 'px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed';
  const backCls  = 'px-4 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300';

  const steps = [
    { n: 1, label: 'Connection' },
    { n: 2, label: 'Credentials' },
    { n: 3, label: 'Objects' },
    { n: 4, label: 'Attributes' },
    { n: 5, label: 'Type mapping' },
    { n: 6, label: 'Schedule' },
  ];
  const handleStepClick = (n) => { setStep(n); if (n === 3 || n === 4) fetchDiscovery(); };

  const attributePicker = (label, available, selected, setSelected) => (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</p>
        <button type="button" onClick={() => setSelected(toggleAllAttributes(selected, available))}
          disabled={!available.length}
          className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-40 disabled:no-underline">
          Select all
        </button>
      </div>
      {available.length === 0
        ? <p className="text-xs text-gray-500 dark:text-gray-400">No additional attributes discovered.</p>
        : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1 max-h-56 overflow-y-auto p-2 border border-gray-200 rounded dark:border-gray-600">
            {available.map(a => (
              <label key={a} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={selected.includes(a)} onChange={() => setSelected(toggleAttribute(selected, a))} />
                <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{a}</span>
              </label>
            ))}
          </div>
        )}
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{selected.length} selected</p>
    </div>
  );

  return (
    <WizardShell
      title={`${isEdit ? 'Edit' : 'Add'} SCIM 2.0 Crawler`}
      onCancel={onCancel}
      steps={steps}
      currentStep={step}
      onStepClick={handleStepClick}
      allowAllSteps={isEdit}
      error={error}
    >

      {/* Step 1 — Connection */}
      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Crawler Name</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputCls} placeholder="SCIM 2.0" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SCIM Base URL</label>
            <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} className={monoCls} placeholder="https://api.example.com/scim/v2" />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">The URL that serves <code>/Users</code> and <code>/Groups</code>, e.g. <code>https://host/scim/v2</code></p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">System name <span className="font-normal text-gray-500">(optional)</span></label>
            <input value={systemName} onChange={e => setSystemName(e.target.value)} className={inputCls} placeholder="SAP CIS" />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">How this source is labelled in Identity Atlas. Defaults to “SCIM”.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Authentication Method</label>
            <div className="space-y-2">
              {AUTH_METHODS.map(m => (
                <label key={m.id} className="flex items-start gap-3 cursor-pointer">
                  <input type="radio" name="scimAuthMethod" value={m.id} checked={authMethod === m.id} onChange={() => setAuthMethod(m.id)} className="mt-0.5" />
                  <div>
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{m.label}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">{m.description}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end">
            <button onClick={() => setStep(2)} disabled={!canStep1} className={nextCls}>Next →</button>
          </div>
        </div>
      )}

      {/* Step 2 — Credentials */}
      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Auth method: <span className="font-medium text-gray-700 dark:text-gray-300">{authMethod}</span>
            {isEdit && <span className="ml-2 text-xs">(leave secret fields blank to keep the stored value)</span>}
          </p>
          {authMethod === 'BasicAuth' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
                <input value={username} onChange={e => setUsername(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} className={inputCls} placeholder={isEdit ? SECRET_PLACEHOLDER : ''} />
              </div>
            </>
          )}
          {authMethod === 'ApiToken' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">API Token</label>
              <input type="password" value={apiToken} onChange={e => setApiToken(e.target.value)} className={monoCls} placeholder={isEdit ? SECRET_PLACEHOLDER : ''} />
            </div>
          )}
          {authMethod === 'OAuth2CC' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Token Endpoint URL</label>
                <input value={tokenEndpoint} onChange={e => setTokenEndpoint(e.target.value)} className={monoCls} placeholder="https://idp.example.com/oauth2/token" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Client ID</label>
                <input value={clientId} onChange={e => setClientId(e.target.value)} className={monoCls} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Client Secret</label>
                <input type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} className={inputCls} placeholder={isEdit ? SECRET_PLACEHOLDER : ''} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Scope <span className="font-normal text-gray-500">(optional)</span></label>
                <input value={scope} onChange={e => setScope(e.target.value)} className={monoCls} placeholder="scim:read" />
              </div>
            </>
          )}
          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className={backCls}>← Back</button>
            <button onClick={() => { setStep(3); fetchDiscovery(); }} disabled={!canStep2} className={nextCls}>Next →</button>
          </div>
        </div>
      )}

      {/* Step 3 — Discover & objects */}
      {step === 3 && (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-gray-400">Choose what to sync from this endpoint.</p>
            <button type="button" onClick={() => fetchDiscovery({ force: true })} disabled={discoLoading}
              className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-40">
              {discoLoading ? 'Discovering…' : 'Re-run discovery'}
            </button>
          </div>
          {discoError && <p className="text-xs text-amber-600 dark:text-amber-400">{discoError}</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
            {SYNC_OPTIONS.map(opt => (
              <label key={opt.key} className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={!!selectedObjects[opt.key]}
                  onChange={e => setSelectedObjects(prev => ({ ...prev, [opt.key]: e.target.checked }))} className="mt-0.5" />
                <div>
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{opt.label}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">{opt.description}</span>
                </div>
              </label>
            ))}
          </div>
          {!canStep3 && <p className="text-xs text-amber-600 dark:text-amber-400">Select at least Users or Groups.</p>}

          {(disco?.resourceTypes || []).some(rt => !rt.syncable) && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                Also served by this endpoint, but not syncable yet:
              </p>
              <div className="flex flex-wrap gap-1">
                {disco.resourceTypes.filter(rt => !rt.syncable).map(rt => (
                  <span key={rt.id} className="px-1.5 py-0.5 text-xs rounded bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">{rt.name}</span>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-700 dark:text-gray-300">Page size</label>
            <input type="number" min="1" value={pageSize} onChange={e => setPageSize(e.target.value)}
              className="w-24 border border-gray-200 rounded px-2 py-1 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200" />
            <span className="text-xs text-gray-500 dark:text-gray-400">the SCIM <code>count</code> parameter (default 100)</span>
          </div>

          <div className="flex justify-between">
            <button onClick={() => setStep(2)} className={backCls}>← Back</button>
            <button onClick={() => { setStep(4); fetchDiscovery(); }} disabled={!canStep3} className={nextCls}>Next →</button>
          </div>
        </div>
      )}

      {/* Step 4 — Attributes (opt-in) */}
      {step === 4 && (
        <div className="space-y-5">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            The core mapping (user name, display name, active, e-mail, user type; group display name) is always synced.
            Pick any <strong>extra</strong> attributes to store — nothing extra is synced unless you select it here.
          </p>
          {discoLoading && <p className="text-xs text-gray-600 dark:text-gray-400 italic">Discovering attributes from /Schemas…</p>}
          {discoError && <p className="text-xs text-amber-600 dark:text-amber-400">{discoError}</p>}
          {attributePicker('User attributes', disco?.userAttributes || [], userAttributes, setUserAttributes)}
          {attributePicker('Group attributes', disco?.groupAttributes || [], groupAttributes, setGroupAttributes)}
          <div className="flex justify-between">
            <button onClick={() => setStep(3)} className={backCls}>← Back</button>
            <button onClick={() => setStep(5)} className={nextCls}>Next →</button>
          </div>
        </div>
      )}

      {/* Step 5 — userType → principalType mapping */}
      {step === 5 && (
        <div className="space-y-4">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">User type → principal type</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Map a SCIM <code>userType</code> to an Identity Atlas principal type. A row with a blank user type is the
            catch-all. Default: every account → User.
          </p>
          <MappingRows
            rows={typeMapping}
            onAdd={addMap}
            onRemove={rmMap}
            onUpdate={upMap}
            headers={['SCIM userType', 'Principal type']}
            addLabel="+ Add rule"
            columns={[
              { key: 'userType', render: (v, onChange) => (
                <Combobox value={v} onChange={onChange}
                  options={[]}
                  defaultOption={{ value: '', label: '(any / catch-all)' }}
                  placeholder="(any / catch-all)"
                  className={FIELD_CLS} />
              )},
              { key: 'principalType', render: (v, onChange) => (
                <Select value={v} onChange={e => onChange(e.target.value)} className={FIELD_CLS + ' bg-white'}>
                  {PRINCIPAL_TYPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </Select>
              )},
            ]}
          />
          <div className="flex justify-between">
            <button onClick={() => setStep(4)} className={backCls}>← Back</button>
            <button onClick={() => setStep(6)} className={nextCls}>Next →</button>
          </div>
        </div>
      )}

      {/* Step 6 — Schedule & save */}
      {step === 6 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Schedule automatic syncs. SCIM has no standard change feed, so every run is a full sync.
          </p>
          {schedules.length === 0 && (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded text-center text-sm text-gray-500 dark:bg-gray-700/50 dark:border-gray-600 dark:text-gray-400">
              No schedules configured. The crawler will only run when you click &quot;Run Now&quot;.
            </div>
          )}
          {schedules.map((s, i) => (
            <ScheduleEditor key={i}
              schedule={{ enabled: true, ...s }}
              onChange={(updated) => setSchedules(schedules.map((x, idx) => idx === i ? { ...updated, enabled: true } : x))}
              onRemove={() => setSchedules(schedules.filter((_, idx) => idx !== i))}
            />
          ))}
          <button onClick={() => setSchedules([...schedules, { enabled: true, syncMode: 'full', frequency: 'daily', hour: 2, minute: 0 }])}
            className="px-3 py-1.5 text-xs bg-gray-200 rounded hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">+ Add Schedule</button>

          <div className="border-t border-gray-200 dark:border-gray-700 pt-3 text-xs text-gray-500 dark:text-gray-400 space-y-1">
            <div>Endpoint: <span className="font-mono text-gray-700 dark:text-gray-300">{baseUrl || '—'}</span></div>
            <div>Objects: {SYNC_OPTIONS.filter(o => selectedObjects[o.key]).map(o => o.label).join(', ') || 'none'}</div>
            <div>Extra attributes: {userAttributes.length} user, {groupAttributes.length} group</div>
          </div>

          <div className="flex justify-between">
            <button onClick={() => setStep(5)} className={backCls}>← Back</button>
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
