import { useState } from 'react';
import MappingRows from '@ui/components/MappingRows';
import WizardShell from '@ui/components/WizardShell';
import Combobox from '@ui/components/inputs/Combobox';
import Select from '@ui/components/inputs/Select';
import { canSubmitCredentials, buildCredentialFields } from '@ui/utils/crawlerCredentials';
import CredentialFields from '@ui/components/crawler/CredentialFields';
import { CrawlerField, OptionList, WizardNav, ScheduleList } from '@ui/components/crawler/wizardFields';
import useCrawlerSave from '@ui/components/crawler/useCrawlerSave';

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
const CRAWLER_TYPE = 'scim';
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

  // Credential fields (secrets start blank; blank = keep stored value in edit mode).
  // One object rather than a useState each: CredentialFields renders whichever
  // set the active auth method needs, and canSubmitCredentials /
  // buildCredentialFields already take the same shape.
  const [creds, setCreds] = useState({
    username: initialConfig?.username || '',
    password: '',
    apiToken: '',
    clientId: initialConfig?.clientId || '',
    clientSecret: '',
    tokenEndpoint: initialConfig?.tokenEndpoint || '',
  });
  const setCred = (name, value) => setCreds(prev => ({ ...prev, [name]: value }));
  const [scope, setScope] = useState(initialConfig?.scope || '');

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
        : { config: { baseUrl: baseUrl.trim(), authMethod, scope: scope.trim(),
                      ...Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, v.trim()])) } };
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
  const { save, saving, error } = useCrawlerSave({
    authFetch, crawlerType: CRAWLER_TYPE, configId: initialConfig?.id, onComplete,
  });

  const canStep1 = !!(displayName.trim() && baseUrl.trim());
  const credentialFields = creds;
  const canStep2 = canSubmitCredentials(authMethod, credentialFields, isEdit);
  const canStep3 = canSubmitObjects(selectedObjects);

  const handleSave = async () => {
    const configPayload = buildScimConfig({
      baseUrl, authMethod, systemName, pageSize, selectedObjects,
      userAttributes, groupAttributes, userTypeMapping: typeMapping, scope, schedules,
    });
    Object.assign(configPayload, buildCredentialFields(authMethod, credentialFields));

    await save(displayName, configPayload);
  };

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
          <CrawlerField label="Crawler Name" value={displayName} onChange={setDisplayName} placeholder="SCIM 2.0" />
          <CrawlerField
            label="SCIM Base URL" mono value={baseUrl} onChange={setBaseUrl}
            placeholder="https://api.example.com/scim/v2"
            hint={<>The URL that serves <code>/Users</code> and <code>/Groups</code>, e.g. <code>https://host/scim/v2</code></>}
          />
          <CrawlerField
            label="System name" optional value={systemName} onChange={setSystemName} placeholder="SAP CIS"
            hint="How this source is labelled in Identity Atlas. Defaults to “SCIM”."
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Authentication Method</label>
            <OptionList options={AUTH_METHODS} name="scimAuthMethod" selected={authMethod} onSelect={setAuthMethod} />
          </div>
          <WizardNav onNext={() => setStep(2)} nextDisabled={!canStep1} />
        </div>
      )}

      {/* Step 2 — Credentials */}
      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Auth method: <span className="font-medium text-gray-700 dark:text-gray-300">{authMethod}</span>
            {isEdit && <span className="ml-2 text-xs">(leave secret fields blank to keep the stored value)</span>}
          </p>
          <CredentialFields authMethod={authMethod} values={creds} onChange={setCred} isEdit={isEdit} />
          {authMethod === 'OAuth2CC' && (
            <CrawlerField label="Scope" optional mono value={scope} onChange={setScope} placeholder="scim:read" />
          )}
          <WizardNav onBack={() => setStep(1)} onNext={() => { setStep(3); fetchDiscovery(); }} nextDisabled={!canStep2} />
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

          <OptionList
            options={SYNC_OPTIONS} type="checkbox" grid selected={selectedObjects}
            onSelect={(key, checked) => setSelectedObjects(prev => ({ ...prev, [key]: checked }))}
          />
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

          <WizardNav onBack={() => setStep(2)} onNext={() => { setStep(4); fetchDiscovery(); }} nextDisabled={!canStep3} />
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
          <WizardNav onBack={() => setStep(3)} onNext={() => setStep(5)} />
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
          <WizardNav onBack={() => setStep(4)} onNext={() => setStep(6)} />
        </div>
      )}

      {/* Step 6 — Schedule & save */}
      {step === 6 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Schedule automatic syncs. SCIM has no standard change feed, so every run is a full sync.
          </p>
          <ScheduleList schedules={schedules} onChange={setSchedules} />

          <div className="border-t border-gray-200 dark:border-gray-700 pt-3 text-xs text-gray-500 dark:text-gray-400 space-y-1">
            <div>Endpoint: <span className="font-mono text-gray-700 dark:text-gray-300">{baseUrl || '—'}</span></div>
            <div>Objects: {SYNC_OPTIONS.filter(o => selectedObjects[o.key]).map(o => o.label).join(', ') || 'none'}</div>
            <div>Extra attributes: {userAttributes.length} user, {groupAttributes.length} group</div>
          </div>

          <WizardNav
            onBack={() => setStep(5)} onNext={handleSave} nextDisabled={saving}
            nextLabel={saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Crawler'}
            nextCls="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50"
          />
        </div>
      )}
    </WizardShell>
  );
}
