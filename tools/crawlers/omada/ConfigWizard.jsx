import { useState } from 'react';
import ScheduleEditor from '../../../app/ui/src/components/ScheduleEditor';
import Stepper from '../../../app/ui/src/components/Stepper';

// ─── Constants ────────────────────────────────────────────────────────────────

const SECRET_PLACEHOLDER = '••••••••';

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

// ─── Wizard ───────────────────────────────────────────────────────────────────

export default function OmadaConfigWizard({ onComplete, onCancel, initialConfig, isEdit, authFetch }) {
  const [step, setStep] = useState(1);
  const [displayName, setDisplayName]   = useState(initialConfig?.displayName || 'Omada IGA');
  const [baseUrl, setBaseUrl]           = useState(initialConfig?.baseUrl || '');
  const [apiVersion, setApiVersion]     = useState(initialConfig?.apiVersion || 'v14');
  const [authMethod, setAuthMethod]     = useState(initialConfig?.authMethod || 'FormCookie');

  // Credential fields
  const [username, setUsername]         = useState(initialConfig?.username || '');
  const [password, setPassword]         = useState('');
  const [clientId, setClientId]         = useState(initialConfig?.clientId || '');
  const [clientSecret, setClientSecret] = useState('');
  const [tokenEndpoint, setTokenEndpoint] = useState(initialConfig?.tokenEndpoint || '');
  const [apiToken, setApiToken]         = useState('');
  const [cookieString, setCookieString] = useState('');
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

  const ctxValidation = (cot) => {
    if (!metaEntitySets) return null;
    const errs = [];
    if (cot.entitySet && !metaEntitySets.includes(cot.entitySet)) {
      // Check for a case-insensitive match and suggest the correct casing
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
  };

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
  const canStep2 = (() => {
    if (authMethod === 'FormCookie') {
      return username.trim() && (password.trim() || isEdit);
    }
    if (authMethod === 'OAuth2CC') {
      return tokenEndpoint.trim() && clientId.trim() && (clientSecret.trim() || isEdit);
    }
    if (authMethod === 'OAuth2ROPC') {
      return tokenEndpoint.trim() && clientId.trim() && (clientSecret.trim() || isEdit) && username.trim() && (password.trim() || isEdit);
    }
    if (authMethod === 'ApiToken') return apiToken.trim() || isEdit;
    if (authMethod === 'CookieString') return cookieString.trim() || isEdit;
    if (authMethod === 'BasicAuth') return username.trim() && (password.trim() || isEdit);
    return true;
  })();

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

      // Only include credential fields that have values (blank = keep existing in edit mode)
      if (authMethod === 'FormCookie' || authMethod === 'OAuth2ROPC') {
        configPayload.username = username.trim();
        if (password.trim()) configPayload.password = password.trim();
      }
      if (authMethod === 'OAuth2CC' || authMethod === 'OAuth2ROPC') {
        configPayload.tokenEndpoint = tokenEndpoint.trim();
        configPayload.clientId = clientId.trim();
        if (clientSecret.trim()) configPayload.clientSecret = clientSecret.trim();
      }
      if (authMethod === 'ApiToken') {
        if (apiToken.trim()) configPayload.apiToken = apiToken.trim();
      }
      if (authMethod === 'CookieString') {
        if (cookieString.trim()) configPayload.cookieString = cookieString.trim();
      }
      if (authMethod === 'BasicAuth') {
        configPayload.username = username.trim();
        if (password.trim()) configPayload.password = password.trim();
      }

      let r;
      if (initialConfig?.id) {
        r = await authFetch(`/api/admin/crawler-configs/${initialConfig.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: displayName.trim(), config: configPayload }),
        });
      } else {
        r = await authFetch('/api/admin/crawler-configs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ crawlerType: 'omada', displayName: displayName.trim(), config: configPayload }),
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
    { n: 1, label: 'Connection' },
    { n: 2, label: 'Credentials' },
    { n: 3, label: 'Sync Options' },
    { n: 4, label: 'Schedule' },
  ];
  const handleStepClick = (n) => { setStep(n); if (n === 3) fetchMetadata(); };

  return (
    <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg dark:bg-gray-800 dark:border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold dark:text-white">{isEdit ? 'Edit' : 'Add'} Omada IGA Crawler</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-700 text-sm dark:text-gray-400 dark:hover:text-gray-200">Cancel</button>
      </div>

      <div className="mb-5"><Stepper steps={steps} current={step} onStepClick={handleStepClick} allowAll={!!isEdit} /></div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-sm dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">{error}</div>}

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
          <div className="flex justify-end">
            <button onClick={() => setStep(2)} disabled={!canStep1}
              className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">
              Next →
            </button>
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

          {(authMethod === 'FormCookie' || authMethod === 'OAuth2ROPC') && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
                <input value={username} onChange={e => setUsername(e.target.value)}
                  className="w-full border border-gray-200 rounded px-3 py-2 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                  placeholder="svc-crawler" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  className="w-full border border-gray-200 rounded px-3 py-2 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                  placeholder={isEdit ? SECRET_PLACEHOLDER : ''} />
              </div>
            </>
          )}
          {(authMethod === 'OAuth2CC' || authMethod === 'OAuth2ROPC') && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Token Endpoint URL</label>
                <input value={tokenEndpoint} onChange={e => setTokenEndpoint(e.target.value)}
                  className="w-full border border-gray-200 rounded px-3 py-2 text-sm font-mono bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                  placeholder="https://omada.example.com/oauth2/token" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Client ID</label>
                <input value={clientId} onChange={e => setClientId(e.target.value)}
                  className="w-full border border-gray-200 rounded px-3 py-2 text-sm font-mono bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Client Secret</label>
                <input type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)}
                  className="w-full border border-gray-200 rounded px-3 py-2 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                  placeholder={isEdit ? SECRET_PLACEHOLDER : ''} />
              </div>
            </>
          )}
          {authMethod === 'ApiToken' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">API Token</label>
              <input type="password" value={apiToken} onChange={e => setApiToken(e.target.value)}
                className="w-full border border-gray-200 rounded px-3 py-2 text-sm font-mono bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                placeholder={isEdit ? SECRET_PLACEHOLDER : ''} />
            </div>
          )}
          {authMethod === 'BasicAuth' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
                <input value={username} onChange={e => setUsername(e.target.value)}
                  className="w-full border border-gray-200 rounded px-3 py-2 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                  placeholder="svc-crawler" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  className="w-full border border-gray-200 rounded px-3 py-2 text-sm bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                  placeholder={isEdit ? SECRET_PLACEHOLDER : ''} />
              </div>
            </>
          )}
          {authMethod === 'CookieString' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cookie String</label>
              <textarea value={cookieString} onChange={e => setCookieString(e.target.value)} rows={3}
                className="w-full border border-gray-200 rounded px-3 py-2 text-sm font-mono bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                placeholder={isEdit ? SECRET_PLACEHOLDER : 'ASP.NET_SessionId=abc123; OmadaAuth=xyz456'} />
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
            </div>
          )}

          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className="px-4 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300">← Back</button>
            <button onClick={() => handleStepClick(3)} disabled={!canStep2}
              className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">
              Next →
            </button>
          </div>
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
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 pr-6">
                <span>ROLECATEGORY value</span><span>Identity Atlas type</span>
              </div>
              {resCategoryMapping.map((m, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input value={m.category} onChange={e => updateResMapping(i, 'category', e.target.value)}
                    placeholder="e.g. Role  (blank = default)"
                    className="flex-1 min-w-0 text-sm border border-gray-300 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200" />
                  <select value={m.resourceType} onChange={e => updateResMapping(i, 'resourceType', e.target.value)}
                    className="flex-1 min-w-0 text-sm border border-gray-300 rounded px-2 py-1 bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
                    {RESOURCE_TYPE_OPTIONS.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                  <button onClick={() => removeResMapping(i)} disabled={resCategoryMapping.length === 1}
                    className="text-gray-600 dark:text-gray-400 hover:text-red-500 text-lg leading-none disabled:opacity-30" title="Remove">×</button>
                </div>
              ))}
            </div>
            <button onClick={addResMapping}
              className="mt-2 text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300">
              + Add mapping row
            </button>
          </div>

          <div className="flex justify-between">
            <button onClick={() => setStep(2)} className="px-4 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300">← Back</button>
            <button onClick={() => setStep(4)} className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700">Next →</button>
          </div>
        </div>
      )}

      {/* Step 4 — Schedule */}
      {step === 4 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Omada has no native delta API — each scheduled run performs a full sync.
          </p>
          {schedules.length === 0 && (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded text-center text-sm text-gray-500 dark:bg-gray-700/50 dark:border-gray-600 dark:text-gray-400">
              No schedules configured. The crawler will only run when you click "Run Now".
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
            className="px-3 py-1.5 text-xs bg-gray-200 rounded hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
            + Add Schedule
          </button>
          <div className="flex justify-between">
            <button onClick={() => setStep(3)} className="px-4 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300">← Back</button>
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
