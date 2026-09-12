import { useState } from 'react';
import MappingRows from '@ui/components/MappingRows';
import WizardShell from '@ui/components/WizardShell';
import { canSubmitCredentials, buildCredentialFields } from '@ui/utils/crawlerCredentials';
import CredentialFields from '@ui/components/crawler/CredentialFields';
import { ScheduleList, WizardNav } from '@ui/components/crawler/wizardFields';
import saveCrawlerConfig from '@ui/components/crawler/saveCrawlerConfig';

// ─── Constants ────────────────────────────────────────────────────────────────

const CRAWLER_TYPE = 'omada';

const AUTH_METHODS = [
  { id: 'FormCookie',   label: 'Form / Cookie',              description: 'POST username+password to /api/authenticate (on-premise)' },
  { id: 'OAuth2CC',     label: 'OAuth2 Client Credentials',  description: 'service-to-service bearer token (Cloud / newer on-prem)' },
  { id: 'OAuth2ROPC',   label: 'OAuth2 ROPC',                description: 'username+password via token endpoint (on-premise with OAuth2)' },
  { id: 'ApiToken',     label: 'API Token',                  description: 'static bearer token' },
  { id: 'CookieString', label: 'Cookie String',              description: 'paste a pre-built session cookie (testing / restricted envs)' },
  { id: 'BasicAuth',    label: 'HTTP Basic Auth',            description: 'Authorization: Basic header — username + password (on-premise)' },
];

const VERSIONS = [
  { id: 'v14', label: 'On-premise v14' },
  { id: 'v15', label: 'On-premise v15' },
  { id: 'cloud', label: 'Omada Cloud' },
];

const SYNC_OPTIONS = [
  { key: 'contexts',        label: 'Contexts',          description: 'Configured context types (OrgUnit, Country, Job titles, etc.)' },
  { key: 'identities',      label: 'Identities',        description: 'Person records and their attributes' },
  { key: 'accounts',        label: 'Accounts',          description: 'User and service accounts (Principals)' },
  { key: 'contextMembers',  label: 'Context Members',   description: 'Identity-to-context memberships from Contextassignment, OUREF, Employment' },
  { key: 'resources',       label: 'Resources',         description: 'Business roles and other permissions, grouped by connected system' },
  { key: 'entitlements',    label: 'Entitlements',      description: 'Role-to-resource containment (ResourceRelationships)' },
  { key: 'assignments',     label: 'Assignments',       description: 'Role assignments (Resourceassignment) and account assignments (CRA)' },
];

const RESOURCE_TYPE_OPTIONS = ['BusinessRole', 'Resource', 'AppRole', 'DelegatedPermission'];
const FIELD_CLS = 'w-full text-sm border border-gray-300 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';

// Validates one contextObjectTypes row's entitySet/identityField against the
// live $metadata lists fetched from the Omada server. Pure function (no
// closure over component state) so it's independently unit-testable — see
// credentialGating.test.js. Returns null when metadata hasn't been fetched
// yet (nothing to validate against), otherwise an array of error strings
// (empty = valid). entitySet/identityField names are case-sensitive against
// the real OData service, so a case-insensitive match is suggested as a
// "did you mean" hint rather than silently accepted.
export function validateContextObjectType(cot, metaEntitySets, metaIdentityProps) {
  if (!metaEntitySets) return null;
  const errs = [];
  if (cot.entitySet && !metaEntitySets.includes(cot.entitySet)) {
    const suggestion = metaEntitySets.find(s => s.toLowerCase() === cot.entitySet.toLowerCase());
    errs.push(suggestion
      ? `"${cot.entitySet}" not found — names are case-sensitive. Did you mean "${suggestion}"?`
      : `"${cot.entitySet}" is not an entity set in $metadata (names are case-sensitive)`);
  }
  if (cot.identityField && metaIdentityProps && !metaIdentityProps.includes(cot.identityField)) {
    const suggestion = metaIdentityProps.find(p => p.toLowerCase() === cot.identityField.toLowerCase());
    errs.push(suggestion
      ? `"${cot.identityField}" not found — names are case-sensitive. Did you mean "${suggestion}"?`
      : `"${cot.identityField}" is not a property of the Identity entity type (names are case-sensitive)`);
  }
  return errs;
}

// ─── Wizard ───────────────────────────────────────────────────────────────────

export default function OmadaConfigWizard({ onComplete, onCancel, initialConfig, isEdit, authFetch }) {
  const [step, setStep] = useState(1);
  const [displayName, setDisplayName]   = useState(initialConfig?.displayName || 'Omada IGA');
  const [baseUrl, setBaseUrl]           = useState(initialConfig?.baseUrl || '');
  const [apiVersion, setApiVersion]     = useState(initialConfig?.apiVersion || 'v14');
  const [authMethod, setAuthMethod]     = useState(initialConfig?.authMethod || 'FormCookie');

  // Credential fields
  // One object rather than a useState each — the shape canSubmitCredentials and
  // buildCredentialFields already take, and what CredentialFields renders from.
  const [creds, setCreds] = useState({
    username: initialConfig?.username || '',
    password: '',
    clientId: initialConfig?.clientId || '',
    clientSecret: '',
    tokenEndpoint: initialConfig?.tokenEndpoint || '',
    apiToken: '',
    cookieString: '',
  });
  const setCred = (name, value) => setCreds(prev => ({ ...prev, [name]: value }));
  const [showCookieHelp, setShowCookieHelp] = useState(false);

  // Sync options
  const defaultObjects = { contexts: true, identities: true, accounts: true, contextMembers: true, resources: true, entitlements: true, assignments: true };
  const [selectedObjects, setSelectedObjects] = useState({ ...defaultObjects, ...(initialConfig?.selectedObjects || {}) });

  // Context object types — each entry specifies which Omada entity sets to sync as contexts.
  // Default: Orgunit only. Operators add Country, Building, etc. as needed.
  const defaultContextTypes = [{ entitySet: 'Orgunit', contextType: 'OrgUnit', identityField: 'OUREF' }];
  const [contextObjectTypes, setContextObjectTypes] = useState(
    initialConfig?.contextObjectTypes?.length
      ? initialConfig.contextObjectTypes.map(c => ({
          entitySet:    c.entitySet    || '',
          contextType:  c.contextType  || '',
          identityField: c.identityField || '',
        }))
      : defaultContextTypes
  );
  const addContextType    = () => setContextObjectTypes(prev => [...prev, { entitySet: '', contextType: '', identityField: '' }]);
  const removeContextType = i  => setContextObjectTypes(prev => prev.filter((_, idx) => idx !== i));
  const updateContextType = (i, field, val) =>
    setContextObjectTypes(prev => prev.map((e, idx) => idx === i ? { ...e, [field]: val } : e));

  // Metadata validation — fetched once when entering Step 3
  const [metaEntitySets,   setMetaEntitySets]   = useState(null);   // null = not fetched yet
  const [metaIdentityProps, setMetaIdentityProps] = useState(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError,   setMetaError]   = useState(null);

  const fetchMetadata = async () => {
    if (metaEntitySets !== null) return;
    setMetaLoading(true); setMetaError(null);
    try {
      const body = initialConfig?.id
        ? { configId: initialConfig.id }
        : { config: { baseUrl: baseUrl.trim(), authMethod, username: username.trim(), password: password.trim(),
                      tokenEndpoint: tokenEndpoint.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim(),
                      apiToken: apiToken.trim(), cookieString: cookieString.trim() } };
      const r = await authFetch('/api/admin/crawlers/omada/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const d = await r.json();
        setMetaEntitySets(d.entitySets || []);
        setMetaIdentityProps(d.identityProperties || []);
      } else {
        setMetaError('Could not reach Omada server — validation unavailable');
      }
    } catch { setMetaError('Metadata fetch failed'); }
    finally { setMetaLoading(false); }
  };

  const ctxValidation = (cot) => validateContextObjectType(cot, metaEntitySets, metaIdentityProps);

  // Resource category mapping — maps ROLECATEGORY to Identity Atlas resourceType + optional tags
  const defaultCategoryMapping = [
    { category: 'Role',       resourceType: 'BusinessRole' },
    { category: 'Permission', resourceType: 'Resource' },
    { category: '',           resourceType: 'Resource' },
  ];
  const [resCategoryMapping, setResCategoryMapping] = useState(
    initialConfig?.resourceCategoryMapping?.length
      ? initialConfig.resourceCategoryMapping.map(m => ({
          category:     m.category     || '',
          resourceType: m.resourceType || 'Resource',
        }))
      : defaultCategoryMapping
  );
  const addResMapping    = () => setResCategoryMapping(prev => [...prev, { category: '', resourceType: 'Resource' }]);
  const removeResMapping = i  => setResCategoryMapping(prev => prev.filter((_, idx) => idx !== i));
  const updateResMapping = (i, field, val) =>
    setResCategoryMapping(prev => prev.map((e, idx) => idx === i ? { ...e, [field]: val } : e));

  // Schedule
  const [schedules, setSchedules] = useState(initialConfig?.schedules || []);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const canStep1 = displayName.trim() && baseUrl.trim();
  const credentialFields = creds;
  const canStep2 = canSubmitCredentials(authMethod, credentialFields, isEdit);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const configPayload = {
        baseUrl: baseUrl.trim(),
        apiVersion,
        authMethod,
        selectedObjects,
        contextObjectTypes: contextObjectTypes
          .filter(c => c.entitySet.trim())
          .map(c => ({
            entitySet:    c.entitySet.trim(),
            contextType:  c.contextType.trim()  || c.entitySet.trim(),
            identityField: c.identityField.trim() || undefined,
          })),
        resourceCategoryMapping: resCategoryMapping
          .map(m => ({
            category:    m.category.trim(),
            resourceType: m.resourceType || 'Resource',
          })),
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

  const steps = [
    { n: 1, label: 'Connection' },
    { n: 2, label: 'Credentials' },
    { n: 3, label: 'Sync Options' },
    { n: 4, label: 'Schedule' },
  ];
  const handleStepClick = (n) => { setStep(n); if (n === 3) fetchMetadata(); };

  return (
    <WizardShell
      title={`${isEdit ? 'Edit' : 'Add'} Omada IGA Crawler`}
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
            <input value={displayName} onChange={e => setDisplayName(e.target.value)}
              className="w-full border border-gray-200 rounded px-3 py-2 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              placeholder="Omada IGA" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Omada Base URL</label>
            <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
              className="w-full border border-gray-200 rounded px-3 py-2 text-sm font-mono bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              placeholder="https://omada.example.com" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Omada Version</label>
            <div className="flex gap-2">
              {VERSIONS.map(v => (
                <button key={v.id} onClick={() => setApiVersion(v.id)}
                  className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                    apiVersion === v.id
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-gray-600 dark:text-gray-400'
                  }`}
                >{v.label}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Authentication Method</label>
            <div className="space-y-2">
              {AUTH_METHODS.map(m => (
                <label key={m.id} className="flex items-start gap-3 cursor-pointer">
                  <input type="radio" name="authMethod" value={m.id} checked={authMethod === m.id}
                    onChange={() => setAuthMethod(m.id)} className="mt-0.5" />
                  <div>
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{m.label}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">{m.description}</span>
                  </div>
                </label>
              ))}
            </div>
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
            placeholders={{ username: 'svc-crawler', tokenEndpoint: 'https://omada.example.com/oauth2/token',
                            cookieString: 'ASP.NET_SessionId=abc123; OmadaAuth=xyz456' }}
            extras={{ cookieString: (
              <>
                <button onClick={() => setShowCookieHelp(h => !h)}
                  className="mt-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
                  {showCookieHelp ? '▲ Hide' : '▶ How to get the cookie string'}
                </button>
                {showCookieHelp && (
                  <div className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded text-xs space-y-2 dark:bg-gray-700/50 dark:border-gray-600 text-gray-700 dark:text-gray-300">
                    <p><strong>Omada Cloud (oisauthtoken):</strong> Log in to Omada Cloud → F12 DevTools → Application → Cookies → find <code>oisauthtoken</code> → copy its <em>Value</em> (a long JWT starting with <code>eyJ…</code>) → enter as <code>oisauthtoken=eyJ…</code></p>
                    <p className="text-amber-600 dark:text-amber-400 font-medium">The value must start with <code>oisauthtoken=</code> followed by the full JWT (200+ characters). A short or missing value will cause 401 errors even though the format is correct.</p>
                    <p><strong>On-premise (multiple cookies):</strong> Log in → F12 → Application → Cookies → copy all Name=Value pairs → join with <code>; </code> (e.g. <code>ASP.NET_SessionId=abc; OmadaAuth=xyz</code>)</p>
                    <p><strong>PowerShell direct (on-prem):</strong></p>
                    <pre className="bg-gray-100 dark:bg-gray-800 p-2 rounded overflow-x-auto">{`$s = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
Invoke-RestMethod -Uri "https://omada.example.com/api/authenticate" \\
  -Method Post -ContentType application/json \\
  -Body '{"Username":"svc","Password":"..."}' \\
  -SessionVariable s | Out-Null
$s.Cookies.GetCookies([Uri]"https://omada.example.com") |
  ForEach-Object { "$($_.Name)=$($_.Value)" } | Join-String -Separator '; '`}</pre>
                    <p className="text-gray-500 dark:text-gray-400">⚠️ Omada session cookies expire (typically 20–60 min). Use FormCookie or OAuth2 for unattended scheduled syncs.</p>
                  </div>
                )}

              </>
            ) }}
          />

          <WizardNav onBack={() => setStep(1)} onNext={() => handleStepClick(3)} nextDisabled={!canStep2} />
        </div>
      )}

      {/* Step 3 — Sync Options */}
      {step === 3 && (
        <div className="space-y-6">
          {/* Sync object toggles */}
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">Choose which Omada entity types to sync. All are enabled by default.</p>
            <div className="space-y-2">
              {SYNC_OPTIONS.map(opt => (
                <label key={opt.key} className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={!!selectedObjects[opt.key]}
                    onChange={e => setSelectedObjects(prev => ({ ...prev, [opt.key]: e.target.checked }))}
                    className="mt-0.5" />
                  <div>
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{opt.label}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">{opt.description}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Context object types */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Context Object Types</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Omada entity sets to sync as Identity Atlas Contexts. Each type has its own OData path.
              <code className="ml-1 text-xs bg-gray-100 dark:bg-gray-700 px-1 rounded">identityField</code> links an identity's reference field to that context type for direct membership.
              {' '}<span className="text-amber-600 dark:text-amber-400 font-medium">Names are case-sensitive</span> — use the exact casing from <code className="text-xs bg-gray-100 dark:bg-gray-700 px-1 rounded">$metadata</code> (e.g. <code className="text-xs bg-gray-100 dark:bg-gray-700 px-1 rounded">Job_titles</code>, not <code className="text-xs bg-gray-100 dark:bg-gray-700 px-1 rounded">job_titles</code>).
            </p>
            {metaLoading && (
              <p className="text-xs text-gray-600 dark:text-gray-400 italic">Fetching $metadata for validation…</p>
            )}
            {metaError && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{metaError}</p>
            )}
            <div className="space-y-2">
              {contextObjectTypes.map((cot, i) => {
                const errs = ctxValidation(cot);
                const hasErr = errs && errs.length > 0;
                return (
                  <div key={i} className="space-y-1">
                    <div className="flex gap-2 items-center">
                      <input
                        value={cot.entitySet}
                        onChange={e => updateContextType(i, 'entitySet', e.target.value)}
                        placeholder="Entity set (e.g. Orgunit)"
                        className={`flex-1 min-w-0 text-sm border rounded px-2 py-1 dark:bg-gray-700 dark:text-gray-200
                          ${hasErr && errs.some(e => e.includes(cot.entitySet)) ? 'border-red-400 dark:border-red-500' : 'border-gray-300 dark:border-gray-600'}`}
                      />
                      <input
                        value={cot.contextType}
                        onChange={e => updateContextType(i, 'contextType', e.target.value)}
                        placeholder="Context type (e.g. OrgUnit)"
                        className="flex-1 min-w-0 text-sm border border-gray-300 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                      />
                      <input
                        value={cot.identityField}
                        onChange={e => updateContextType(i, 'identityField', e.target.value)}
                        placeholder="Identity field (e.g. OUREF)"
                        className={`flex-1 min-w-0 text-sm border rounded px-2 py-1 dark:bg-gray-700 dark:text-gray-200
                          ${hasErr && errs.some(e => e.includes(cot.identityField)) ? 'border-red-400 dark:border-red-500' : 'border-gray-300 dark:border-gray-600'}`}
                      />
                      <button
                        onClick={() => removeContextType(i)}
                        disabled={contextObjectTypes.length === 1}
                        className="text-gray-600 dark:text-gray-400 hover:text-red-500 text-lg leading-none disabled:opacity-30"
                        title="Remove">×</button>
                    </div>
                    {hasErr && errs.map((e, j) => (
                      <p key={j} className="text-xs text-red-600 dark:text-red-400 ml-1">⚠ {e}</p>
                    ))}
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <button onClick={addContextType}
                className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300">
                + Add context type
              </button>
              {metaEntitySets && (
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  Available: {metaEntitySets.filter(s => !['Identity','User','Resource','Resourceassignment','System','Usergroup','Orgunit','Country','Employment'].includes(s)
                    ? false : true).join(', ')}
                </span>
              )}
            </div>
          </div>

          {/* Resource category mapping */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Resource Category Mapping</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Maps Omada <code className="text-xs bg-gray-100 dark:bg-gray-700 px-1 rounded">ROLECATEGORY</code> to an
              Identity Atlas resource type. Leave <em>ROLECATEGORY</em> blank for the default/catch-all row (must be last).
            </p>
            <MappingRows
              rows={resCategoryMapping}
              onAdd={addResMapping}
              onRemove={removeResMapping}
              onUpdate={updateResMapping}
              headers={['ROLECATEGORY value', 'Identity Atlas type']}
              addLabel="+ Add mapping row"
              columns={[
                { key: 'category', render: (v, onChange) => (
                  <input value={v} onChange={e => onChange(e.target.value)}
                    placeholder="e.g. Role  (blank = default)"
                    className={FIELD_CLS} />
                )},
                { key: 'resourceType', render: (v, onChange) => (
                  <select value={v} onChange={e => onChange(e.target.value)}
                    className={FIELD_CLS + ' bg-white'}>
                    {RESOURCE_TYPE_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                )},
              ]}
            />
          </div>

          <WizardNav onBack={() => setStep(2)} onNext={() => setStep(4)} />
        </div>
      )}

      {/* Step 4 — Schedule */}
      {step === 4 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Omada has no native delta API — each scheduled run performs a full sync.
          </p>
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
