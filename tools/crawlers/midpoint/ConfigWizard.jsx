import { useState } from 'react';
import MappingRows from '@ui/components/MappingRows';
import WizardShell from '@ui/components/WizardShell';
import Combobox from '@ui/components/inputs/Combobox';
import Select from '@ui/components/inputs/Select';
import { canSubmitCredentials, buildCredentialFields } from '@ui/utils/crawlerCredentials';
import CredentialFields from '@ui/components/crawler/CredentialFields';
import { CrawlerField, OptionList, ScheduleList, WizardNav } from '@ui/components/crawler/wizardFields';
import saveCrawlerConfig from '@ui/components/crawler/saveCrawlerConfig';

// ─── Constants ────────────────────────────────────────────────────────────────

const CRAWLER_TYPE = 'midpoint';

const AUTH_METHODS = [
  { id: 'BasicAuth',  label: 'HTTP Basic Auth',           description: 'username + password (Authorization: Basic)' },
  { id: 'ApiToken',   label: 'API Token',                 description: 'static bearer token' },
  { id: 'OAuth2CC',   label: 'OAuth2 Client Credentials', description: 'service-to-service bearer token' },
  { id: 'OAuth2ROPC', label: 'OAuth2 ROPC',               description: 'username + password via token endpoint' },
];

const SYNC_OPTIONS = [
  { key: 'systems',       label: 'Systems',        description: 'Connected resources (ResourceType) registered as Systems' },
  { key: 'orgs',          label: 'Orgs',           description: 'OrgType → Contexts (org hierarchy)' },
  { key: 'roles',         label: 'Roles',          description: 'RoleType → Resources (classified via the mapping below)' },
  { key: 'services',      label: 'Services',       description: 'ServiceType → Resources' },
  { key: 'users',         label: 'Users',          description: 'UserType → Identities + focus Principals' },
  { key: 'shadows',       label: 'Shadows',        description: 'Accounts + entitlements on connected systems' },
  { key: 'orgMembership', label: 'Org membership', description: 'user.parentOrgRef → Context members' },
  { key: 'assignments',   label: 'Assignments',    description: 'user.assignment → Governed resource assignments' },
  { key: 'roleNesting',   label: 'Role nesting',   description: 'role.inducement → Contains relationships' },
  { key: 'reviews',       label: 'Reviews',        description: 'Certification campaigns → review decisions' },
];

const RESOURCE_TYPE_OPTIONS  = ['BusinessRole', 'Service', 'Resource', 'Application', 'AppRole', 'Entitlement', 'DelegatedPermission'];
const PRINCIPAL_TYPE_OPTIONS = ['User', 'ServicePrincipal', 'ManagedIdentity', 'WorkloadIdentity', 'AIAgent', 'ExternalUser', 'SharedMailbox'];
const FIELD_CLS = 'text-sm border border-gray-300 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';

// ─── Wizard ───────────────────────────────────────────────────────────────────

export default function MidpointConfigWizard({ onComplete, onCancel, initialConfig, isEdit, authFetch }) {
  const [step, setStep] = useState(1);
  const [displayName, setDisplayName] = useState(initialConfig?.displayName || 'midPoint (Evolveum)');
  const [baseUrl, setBaseUrl]         = useState(initialConfig?.baseUrl || '');
  const [authMethod, setAuthMethod]   = useState(initialConfig?.authMethod || 'BasicAuth');

  // Credential fields (secrets start blank; blank = keep stored value in edit mode)
  // One object — the shape canSubmitCredentials / buildCredentialFields take,
  // and what CredentialFields renders from.
  const [creds, setCreds] = useState({
    username: initialConfig?.username || '',
    password: '',
    apiToken: '',
    clientId: initialConfig?.clientId || '',
    clientSecret: '',
    tokenEndpoint: initialConfig?.tokenEndpoint || '',
  });
  const setCred = (name, value) => setCreds(prev => ({ ...prev, [name]: value }));

  const defaultObjects = { systems: true, orgs: true, roles: true, services: true, users: true,
                           shadows: true, orgMembership: true, assignments: true, roleNesting: true, reviews: true };
  const [selectedObjects, setSelectedObjects] = useState({ ...defaultObjects, ...(initialConfig?.selectedObjects || {}) });
  const [pageSize, setPageSize] = useState(initialConfig?.pageSize || 100);

  const [archetypeMapping, setArchetypeMapping] = useState(
    initialConfig?.archetypeMapping?.length
      ? initialConfig.archetypeMapping.map(m => ({ archetype: m.archetype || '', subtype: m.subtype || '', resourceType: m.resourceType || 'BusinessRole' }))
      : [{ archetype: '', subtype: '', resourceType: 'BusinessRole' }]
  );
  const addArch = () => setArchetypeMapping(p => [...p, { archetype: '', subtype: '', resourceType: 'BusinessRole' }]);
  const rmArch  = i => setArchetypeMapping(p => p.filter((_, idx) => idx !== i));
  const upArch  = (i, f, v) => setArchetypeMapping(p => p.map((e, idx) => idx === i ? { ...e, [f]: v } : e));

  const [orgMapping, setOrgMapping] = useState(
    initialConfig?.typeMappings?.orgContextTypeMapping?.length
      ? initialConfig.typeMappings.orgContextTypeMapping.map(m => ({ orgSubtype: m.orgSubtype || '', contextType: m.contextType || 'OrgUnit' }))
      : [{ orgSubtype: '', contextType: 'OrgUnit' }]
  );
  const addOrg = () => setOrgMapping(p => [...p, { orgSubtype: '', contextType: 'OrgUnit' }]);
  const rmOrg  = i => setOrgMapping(p => p.filter((_, idx) => idx !== i));
  const upOrg  = (i, f, v) => setOrgMapping(p => p.map((e, idx) => idx === i ? { ...e, [f]: v } : e));

  const [idMapping, setIdMapping] = useState(
    initialConfig?.typeMappings?.identityTypeMapping?.length
      ? initialConfig.typeMappings.identityTypeMapping.map(m => ({ userType: m.userType || '', principalType: m.principalType || 'User' }))
      : [{ userType: '', principalType: 'User' }]
  );
  const addId = () => setIdMapping(p => [...p, { userType: '', principalType: 'User' }]);
  const rmId  = i => setIdMapping(p => p.filter((_, idx) => idx !== i));
  const upId  = (i, f, v) => setIdMapping(p => p.map((e, idx) => idx === i ? { ...e, [f]: v } : e));

  const [showAdvanced, setShowAdvanced] = useState(false);

  const [disco, setDisco] = useState(null);
  const [discoLoading, setDiscoLoading] = useState(false);
  const [discoError, setDiscoError] = useState(null);

  const fetchDiscovery = async () => {
    if (disco !== null || discoLoading) return;
    setDiscoLoading(true); setDiscoError(null);
    try {
      const body = initialConfig?.id
        ? { configId: initialConfig.id }
        : { config: { baseUrl: baseUrl.trim(), authMethod, username: username.trim(), password: password.trim(),
                      apiToken: apiToken.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim(),
                      tokenEndpoint: tokenEndpoint.trim() } };
      const r = await authFetch('/api/admin/crawlers/midpoint/discover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (r.ok) {
        setDisco(await r.json());
      } else {
        const e = await r.json().catch(() => ({}));
        setDisco({ archetypes: [], roleSubtypes: [], orgSubtypes: [], userTypes: [] });
        setDiscoError(e.error || 'Could not reach midPoint — enter values manually');
      }
    } catch {
      setDisco({ archetypes: [], roleSubtypes: [], orgSubtypes: [], userTypes: [] });
      setDiscoError('Discovery failed — enter values manually');
    } finally { setDiscoLoading(false); }
  };

  const [schedules, setSchedules] = useState(initialConfig?.schedules || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const canStep1 = displayName.trim() && baseUrl.trim();
  const credentialFields = creds;
  const canStep2 = canSubmitCredentials(authMethod, credentialFields, isEdit);

  const handleSave = async () => {
    setSaving(true); setError(null);
    try {
      const configPayload = {
        baseUrl: baseUrl.trim(),
        authMethod,
        pageSize: parseInt(pageSize, 10) || 100,
        selectedObjects,
        archetypeMapping: archetypeMapping.map(m => ({ archetype: m.archetype.trim(), subtype: m.subtype.trim(), resourceType: m.resourceType || 'BusinessRole' })),
        typeMappings: {
          orgContextTypeMapping: orgMapping.map(m => ({ orgSubtype: m.orgSubtype.trim(), contextType: (m.contextType || '').trim() || 'OrgUnit' })),
          identityTypeMapping:   idMapping.map(m => ({ userType: m.userType.trim(), principalType: m.principalType || 'User' })),
        },
      };
      if (schedules.length) configPayload.schedules = schedules;

      Object.assign(configPayload, buildCredentialFields(authMethod, credentialFields));

      await saveCrawlerConfig({
        authFetch, crawlerType: CRAWLER_TYPE, configId: initialConfig?.id,
        displayName, config: configPayload,
      });
      onComplete();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full border border-gray-200 rounded px-3 py-2 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
  const monoCls  = inputCls + ' font-mono';

  const steps = [
    { n: 1, label: 'Connection' },
    { n: 2, label: 'Credentials' },
    { n: 3, label: 'Objects & Mapping' },
    { n: 4, label: 'Schedule' },
  ];
  const handleStepClick = (n) => { setStep(n); if (n === 3) fetchDiscovery(); };

  return (
    <WizardShell
      title={`${isEdit ? 'Edit' : 'Add'} midPoint Crawler`}
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
          <CrawlerField label="Crawler Name" value={displayName} onChange={setDisplayName} placeholder="midPoint (Evolveum)" />
          <CrawlerField
            label="midPoint Base URL" mono value={baseUrl} onChange={setBaseUrl}
            placeholder="https://midpoint.example.com/midpoint"
            hint={<>e.g. <code>https://host:8080/midpoint</code> or <code>…/midpoint/ws/rest</code></>}
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Authentication Method</label>
            <OptionList options={AUTH_METHODS} name="mpAuthMethod" selected={authMethod} onSelect={setAuthMethod} />
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
          <CredentialFields
            authMethod={authMethod} values={creds} onChange={setCred} isEdit={isEdit}
            placeholders={{ username: 'administrator' }}
          />
          <WizardNav onBack={() => setStep(1)} onNext={() => { setStep(3); fetchDiscovery(); }} nextDisabled={!canStep2} />
        </div>
      )}

      {/* Step 3 — Sync options + mappings */}
      {step === 3 && (
        <div className="space-y-6">
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">Choose which midPoint object types to sync. All are enabled by default.</p>
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
            <div className="mt-3 flex items-center gap-2">
              <label className="text-sm text-gray-700 dark:text-gray-300">Page size</label>
              <input type="number" min="1" value={pageSize} onChange={e => setPageSize(e.target.value)}
                className="w-24 border border-gray-200 rounded px-2 py-1 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200" />
              <span className="text-xs text-gray-500 dark:text-gray-400">objects per REST request (default 100)</span>
            </div>
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Role classification (archetype → resource type)</p>
              {discoLoading && <span className="text-xs text-gray-600 dark:text-gray-400 italic">Discovering from midPoint…</span>}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              Each role is matched by <strong>archetype</strong> first, then by <strong>subtype</strong>; a row with both blank is the catch-all.
              Dropdowns are populated live from the midPoint server. Default: every role → BusinessRole.
            </p>
            {discoError && <p className="text-xs text-amber-600 dark:text-amber-400 mb-2">{discoError}</p>}
            <MappingRows
              rows={archetypeMapping}
              onAdd={addArch}
              onRemove={rmArch}
              onUpdate={upArch}
              headers={['Archetype', 'Subtype (fallback)', 'Identity Atlas type']}
              addLabel="+ Add rule"
              columns={[
                { key: 'archetype', render: (v, onChange) => (
                  <Combobox value={v} onChange={onChange}
                    options={(disco?.archetypes || []).map(a => a.name)}
                    defaultOption={{ value: '', label: '(any / catch-all)' }}
                    placeholder="(any / catch-all)"
                    className={FIELD_CLS} />
                )},
                { key: 'subtype', render: (v, onChange) => (
                  <Combobox value={v} onChange={onChange}
                    options={disco?.roleSubtypes || []}
                    defaultOption={{ value: '', label: '(none)' }}
                    placeholder="(optional)"
                    className={FIELD_CLS} />
                )},
                { key: 'resourceType', render: (v, onChange) => (
                  <Select value={v} onChange={e => onChange(e.target.value)}
                    className={FIELD_CLS + ' bg-white'}>
                    {RESOURCE_TYPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </Select>
                )},
              ]}
            />
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <button onClick={() => setShowAdvanced(a => !a)} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
              {showAdvanced ? '▲ Hide' : '▶ Advanced type mappings (orgs, users)'}
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-5">
                <div>
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Org → context type</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Map an OrgType subtype to a context type. Blank subtype = catch-all (default OrgUnit).</p>
                  <MappingRows
                    rows={orgMapping}
                    onAdd={addOrg}
                    onRemove={rmOrg}
                    onUpdate={upOrg}
                    headers={['Org subtype', 'Context type']}
                    addLabel="+ Add rule"
                    columns={[
                      { key: 'orgSubtype', render: (v, onChange) => (
                        <Combobox value={v} onChange={onChange}
                          options={disco?.orgSubtypes || []}
                          defaultOption={{ value: '', label: '(any / catch-all)' }}
                          placeholder="(any / catch-all)"
                          className={FIELD_CLS} />
                      )},
                      { key: 'contextType', render: (v, onChange) => (
                        <input value={v} onChange={e => onChange(e.target.value)} placeholder="OrgUnit"
                          className={'w-full ' + FIELD_CLS} />
                      )},
                    ]}
                  />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">User → principal type</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Map a UserType subtype/employeeType to a principal type. Blank = catch-all (default User).</p>
                  <MappingRows
                    rows={idMapping}
                    onAdd={addId}
                    onRemove={rmId}
                    onUpdate={upId}
                    headers={['User subtype', 'Principal type']}
                    addLabel="+ Add rule"
                    columns={[
                      { key: 'userType', render: (v, onChange) => (
                        <Combobox value={v} onChange={onChange}
                          options={disco?.userTypes || []}
                          defaultOption={{ value: '', label: '(any / catch-all)' }}
                          placeholder="(any / catch-all)"
                          className={FIELD_CLS} />
                      )},
                      { key: 'principalType', render: (v, onChange) => (
                        <Select value={v} onChange={e => onChange(e.target.value)}
                          className={FIELD_CLS + ' bg-white'}>
                          {PRINCIPAL_TYPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                        </Select>
                      )},
                    ]}
                  />
                </div>
              </div>
            )}
          </div>

          <WizardNav onBack={() => setStep(2)} onNext={() => setStep(4)} />
        </div>
      )}

      {/* Step 4 — Schedule */}
      {step === 4 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Schedule automatic syncs (full or delta). Leave empty to run only on demand.</p>
          <ScheduleList schedules={schedules} onChange={setSchedules} />
          <WizardNav
            onBack={() => setStep(3)} onNext={handleSave} nextDisabled={saving}
            nextLabel={saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Crawler'}
            nextCls="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50"
          />
        </div>
      )}
    </WizardShell>
  );
}
