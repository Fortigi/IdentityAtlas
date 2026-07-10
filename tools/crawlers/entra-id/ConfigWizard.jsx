import { useState, useEffect } from 'react';
import ScheduleEditor from '@ui/components/ScheduleEditor';
import WizardShell from '@ui/components/WizardShell';

// ─── Attribute Picker ───────────────────────────────────────────────────────
function AttributePicker({ title, available, selected, onChange, coreAttrs = [] }) {
  const [filter, setFilter] = useState('');
  const coreSet = new Set(coreAttrs);
  // Show core attrs first, then the rest
  const sortedAvailable = [
    ...coreAttrs.filter(a => available.includes(a)),
    ...available.filter(a => !coreSet.has(a)),
  ];
  const visible = sortedAvailable.filter(a => !filter || a.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (attr) => {
    if (coreSet.has(attr)) return; // can't toggle core attrs
    if (selected.includes(attr)) onChange(selected.filter(a => a !== attr));
    else onChange([...selected, attr]);
  };

  const selectAll = () => {
    // Select all non-core attributes (respecting filter if active)
    const visibleNonCore = visible.filter(a => !coreSet.has(a));
    const newSelected = [...new Set([...selected, ...visibleNonCore])];
    onChange(newSelected);
  };

  const deselectAll = () => {
    // Deselect all non-core attributes (respecting filter if active)
    const visibleNonCore = new Set(visible.filter(a => !coreSet.has(a)));
    const newSelected = selected.filter(a => !visibleNonCore.has(a));
    onChange(newSelected);
  };

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-2">
        <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-300">
          {title} ({selected.length} extra + {coreAttrs.length} core)
        </h5>
        <div className="flex items-center gap-2">
          <button
            onClick={selectAll}
            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
            type="button"
          >
            Select All
          </button>
          <button
            onClick={deselectAll}
            className="px-2 py-1 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            type="button"
          >
            Deselect All
          </button>
          <input type="text" value={filter} onChange={e => setFilter(e.target.value)}
            placeholder="Filter..."
            className="px-2 py-1 text-xs border border-gray-200 rounded w-48 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto border border-gray-200 rounded bg-white dark:border-gray-600 dark:bg-gray-800">
        {visible.length === 0 ? (
          <div className="text-xs text-gray-600 italic p-2 dark:text-gray-500">No attributes match filter</div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {visible.map(attr => {
              const isCore = coreSet.has(attr);
              const isSelected = isCore || selected.includes(attr);
              return (
                <label key={attr}
                  className={`flex items-center gap-2 text-xs px-2 py-1 ${
                    isCore ? 'cursor-default bg-blue-50/40 dark:bg-blue-900/20' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                  title={isCore ? 'Core attribute (always synced)' : attr}>
                  <input type="checkbox" checked={isSelected} disabled={isCore}
                    onChange={() => toggle(attr)} className="rounded flex-shrink-0" />
                  <span className="truncate">{attr}</span>
                  {isCore && <span className="text-blue-700 text-[10px] flex-shrink-0">core</span>}
                </label>
              );
            })}
          </div>
        )}
      </div>
      <p className="text-xs text-gray-600 mt-1 dark:text-gray-500">
        <span className="text-blue-500 dark:text-blue-400">core</span> = always synced.
        Extras go into the extendedAttributes JSON column.
      </p>
    </div>
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Core attributes — always synced, shown in the picker as locked/checked.
// These match the crawler's hardcoded core fields in Start-EntraIDCrawler.ps1.
const CORE_USER_ATTRS = [
  'displayName', 'givenName', 'surname', 'mail', 'userPrincipalName',
  'accountEnabled', 'department', 'jobTitle', 'companyName', 'employeeId',
  'createdDateTime',
];
const CORE_GROUP_ATTRS = [
  'displayName', 'description', 'mail', 'visibility', 'createdDateTime',
  'groupTypes', 'securityEnabled', 'mailEnabled',
];

// Default attribute presets — pre-selected (checkable) in the AttributePicker on a fresh crawler.
// These are the "useful extras" beyond core fields. Users can deselect them.
const DEFAULT_IDENTITY_ATTRS = [
  'employeeType', 'employeeHireDate', 'usageLocation', 'country', 'city',
  'officeLocation', 'mobilePhone', 'businessPhones', 'preferredLanguage',
];
const DEFAULT_USER_ATTRS = [
  'employeeType', 'employeeHireDate', 'onPremisesSyncEnabled', 'usageLocation',
  'country', 'city', 'officeLocation', 'mobilePhone', 'businessPhones',
  'preferredLanguage', 'userType',
];
const DEFAULT_GROUP_ATTRS = [
  'classification', 'membershipRule', 'membershipRuleProcessingState',
  'isAssignableToRole', 'theme', 'preferredLanguage', 'preferredDataLocation',
  'onPremisesSyncEnabled',
];

// Builds the { displayName, configPayload } pair sent to POST/PATCH
// /admin/crawler-configs from the wizard's step state. Pulled out of
// handleSave as a pure function — this is where the "Advanced options
// silently dropped on save" bug lived (signInLogsDays/aiNamePatterns were
// computed in the old CrawlersPage.jsx handleWizardComplete from a config
// object that never carried them), so it gets dedicated unit tests instead
// of being only reachable through a full save round-trip.
export function buildEntraConfigPayload({
  crawlerName, organization, tenantId, clientId, clientSecret, selectedObjects,
  identityAttrs, customUserAttrs, customGroupAttrs, schedules,
  idFilterEnabled, idFilterAttr, idFilterCondition, idFilterValue,
  signInLogsDays, aiNamePatterns,
}) {
  const displayName = crawlerName.trim() || `Entra ID — ${organization || 'Unnamed'}`;
  const configPayload = {
    tenantId: tenantId.trim(),
    clientId: clientId.trim(),
    selectedObjects,
  };
  // Empty secret in edit mode means "keep existing"
  if (clientSecret.trim()) configPayload.clientSecret = clientSecret.trim();
  if (identityAttrs.length) configPayload.identityAttributes = identityAttrs;
  if (customUserAttrs.length) configPayload.customUserAttributes = customUserAttrs;
  if (customGroupAttrs.length) configPayload.customGroupAttributes = customGroupAttrs;
  if (schedules.length) configPayload.schedules = schedules;
  if (idFilterEnabled && selectedObjects.identity) {
    configPayload.identityFilter = { attribute: idFilterAttr, condition: idFilterCondition };
    if (idFilterCondition === 'equals' || idFilterCondition === 'notEquals') {
      configPayload.identityFilter.value = idFilterValue;
    }
    if (idFilterCondition === 'inValues') {
      configPayload.identityFilter.values = idFilterValue.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  // Advanced options
  const daysInt = parseInt(signInLogsDays, 10);
  if (Number.isInteger(daysInt) && daysInt >= 1 && daysInt <= 30 && daysInt !== 7) {
    configPayload.signInLogsDays = daysInt;
  }
  const patterns = aiNamePatterns.split('\n').map(s => s.trim()).filter(Boolean);
  if (patterns.length > 0) {
    configPayload.aiNamePatterns = patterns;
  }
  return { displayName, configPayload };
}

// Static fallback catalog of Entra object types, mirroring ENTRA_OBJECT_TYPES
// in discover.js. The authoritative catalog comes from the live `validate`
// response, but that response is wizard-runtime state and is never persisted
// to the crawler config. In edit mode the user often opens step 2 without
// re-entering the client secret (so no fresh validate runs), which left
// `validation.objectTypes` empty and rendered a blank, non-functional step 2 —
// you couldn't toggle a newly-added object type like Directory Roles. This
// fallback keeps the full catalog available for selection in that case; the
// per-object permission gate (canObjectBeSelected) already no-ops when the
// live permission map is absent, so every type stays selectable.
export const ENTRA_OBJECT_TYPES_FALLBACK = [
  { key: 'identity', label: 'Identity', description: 'Personal user accounts that are synced from HR' },
  { key: 'usersGroupsMembers', label: 'Users & Groups & Members', description: 'All users, security groups, and group memberships' },
  { key: 'servicePrincipals', label: 'Service Principals', description: 'Non-human identities (enterprise app SPs, managed identities, AI agents)' },
  { key: 'identityGovernance', label: 'Identity Governance', description: 'Access Packages, assignments, policies, reviews' },
  { key: 'appsAppRoles', label: 'Apps & AppRoles', description: 'Application registrations and role assignments' },
  { key: 'appOwners', label: 'App Owners', description: 'Owners of app registrations (who can add credentials and impersonate the app) and enterprise-app service principals' },
  { key: 'appPermissions', label: 'Application Permissions', description: 'App-only permissions each service principal / managed identity / AI agent holds on other APIs (e.g. Mail.Read on Microsoft Graph) — the admin-consented, tenant-wide kind' },
  { key: 'principalRelationships', label: 'Agent Owners & Guest Sponsors', description: 'Owners of AI agents and sponsors of guest accounts — the person accountable for each non-human / external identity, shown on its relations tab' },
  { key: 'directoryRoles', label: 'Directory Roles', description: 'Entra ID directory role assignments' },
  { key: 'pim', label: 'PIM', description: 'Privileged Identity Management eligible group memberships' },
  { key: 'signInLogs', label: 'Sign-in Logs (per-app activity)', description: 'Aggregated sign-in events — last activity per (user, app) pair' },
  { key: 'oauth2Grants', label: 'OAuth2 Delegated Grants', description: 'Per-user consent grants (user X allowed app Y to call API Z with scope W). Tenant-wide consents are skipped.' },
];

// ─── Wizard ───────────────────────────────────────────────────────────────────
//
// Steps:
//   1. Name + Credentials → Validate
//   2. Object Type Selection
//   3. Identity (filter + attributes) — only if `identity` selected
//   4. Users & Groups (attributes) — only if `usersGroupsMembers` selected
//   5. Schedules (multiple)
//
// `initialConfig` is provided in edit mode to pre-populate all fields.
export default function ConfigWizard({ onComplete, onCancel, initialConfig, isEdit, authFetch }) {
  const [step, setStep] = useState(1);
  const totalSteps = 5;

  // Wizard state
  const [crawlerName, setCrawlerName] = useState(initialConfig?.displayName || '');
  const [tenantId, setTenantId] = useState(initialConfig?.tenantId || '');
  const [clientId, setClientId] = useState(initialConfig?.clientId || '');
  const [clientSecret, setClientSecret] = useState('');
  const [validation, setValidation] = useState(initialConfig?.validation || null);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState(null);

  const [selectedObjects, setSelectedObjects] = useState(initialConfig?.selectedObjects || {});

  // Identity filter
  const [idFilterEnabled, setIdFilterEnabled] = useState(!!initialConfig?.identityFilter?.attribute);
  const [idFilterAttr, setIdFilterAttr] = useState(initialConfig?.identityFilter?.attribute || 'employeeId');
  const [idFilterCondition, setIdFilterCondition] = useState(initialConfig?.identityFilter?.condition || 'isNotNull');
  const [idFilterValue, setIdFilterValue] = useState(
    initialConfig?.identityFilter?.value || (initialConfig?.identityFilter?.values || []).join(', ')
  );
  const [identityAttrs, setIdentityAttrs] = useState(initialConfig?.identityAttributes || []);

  // User/group attributes
  const [customUserAttrs, setCustomUserAttrs] = useState(initialConfig?.customUserAttributes || []);
  const [customGroupAttrs, setCustomGroupAttrs] = useState(initialConfig?.customGroupAttributes || []);

  // Schedules (array)
  const [schedules, setSchedules] = useState(() => {
    if (initialConfig?.schedules?.length) return initialConfig.schedules;
    if (initialConfig?.schedule) return [initialConfig.schedule];
    return [];
  });

  // Advanced options — exposed in a collapsible on step 5. These are read
  // by the worker dispatcher but had no UI surface before.
  // signInLogsDays: how many days of /auditLogs/signIns to pull each run
  //                 (1-30, capped at Graph's retention). Default 7.
  // aiNamePatterns: extra regex fragments applied to SP displayName to
  //                 classify as AIAgent (beyond the built-in list).
  const [signInLogsDays, setSignInLogsDays] = useState(initialConfig?.signInLogsDays ?? 7);
  const [aiNamePatterns, setAiNamePatterns] = useState(
    Array.isArray(initialConfig?.aiNamePatterns) ? initialConfig.aiNamePatterns.join('\n') : ''
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Discovery state — must be declared before the useEffect below that references userAttrCatalog
  const [userAttrCatalog, setUserAttrCatalog] = useState(null);
  const [groupAttrCatalog, setGroupAttrCatalog] = useState(null);
  const [discovering, setDiscovering] = useState(false);

  // When the user picks a Boolean attribute (and isn't using an empty-string
  // operator), default the value state to 'true'. Without this the Boolean
  // <select> displays "true" via `value={idFilterValue || 'true'}` but the
  // underlying state stays '' — which saves as {"value": ""} and matches no
  // rows, silently producing an empty Identities table. Discovered April 2026.
  useEffect(() => {
    if (idFilterCondition === 'isNotNull' || idFilterCondition === 'inValues') return;
    const filterType = userAttrCatalog?.dataTypes?.[idFilterAttr];
    if (filterType === 'Boolean' && (idFilterValue === '' || idFilterValue == null)) {
      setIdFilterValue('true');
    }
  }, [idFilterAttr, idFilterCondition, userAttrCatalog, idFilterValue]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Step visibility
  const stepNeeded = (n) => {
    if (n === 3) return !!selectedObjects.identity;
    if (n === 4) return !!selectedObjects.usersGroupsMembers;
    return true;
  };
  const nextStep = () => {
    let next = step + 1;
    while (next <= totalSteps && !stepNeeded(next)) next++;
    setStep(next);
  };
  const prevStep = () => {
    let prev = step - 1;
    while (prev >= 1 && !stepNeeded(prev)) prev--;
    setStep(prev);
  };

  // Step 1: Validate
  const handleValidate = async () => {
    if (!tenantId.trim() || !clientId.trim()) return;
    if (!isEdit && !clientSecret.trim()) return;
    setValidating(true);
    setValidationError(null);
    try {
      // In edit mode without a new secret, skip validation entirely
      if (isEdit && !clientSecret.trim()) {
        setValidation(initialConfig?.validation || { organization: 'edit mode', permissions: {}, objectTypes: [] });
        nextStep();
        return;
      }
      const r = await authFetch('/api/admin/crawlers/entra-id/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'validate',
          config: { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() },
        }),
      });
      const result = await r.json().catch(() => ({}));
      if (!r.ok) {
        setValidationError(result.error || `HTTP ${r.status}`);
        return;
      }
      if (result.valid) {
        setValidation(result);
        // Pre-check object selections based on permissions
        if (!initialConfig?.selectedObjects) {
          const initial = {};
          for (const ot of result.objectTypes || []) {
            const reqPerms = Object.entries(result.permissionObjectMap || {})
              .filter(([, types]) => types.includes(ot.key))
              .map(([p]) => p);
            initial[ot.key] = reqPerms.length === 0 || reqPerms.some(p => result.permissions?.[p]);
          }
          setSelectedObjects(initial);
        }
        nextStep();
      } else {
        setValidationError(result.error || 'Validation failed');
      }
    } catch (err) {
      setValidationError(err.message);
    } finally {
      setValidating(false);
    }
  };

  // Discover attributes when entering steps 3 or 4
  const ensureUserAttrs = async () => {
    if (userAttrCatalog || discovering) return;
    setDiscovering(true);
    try {
      const body = isEdit && !clientSecret.trim()
        ? { type: 'users', configId: initialConfig?.id }
        : { type: 'users', config: { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() } };
      const r = await authFetch('/api/admin/crawlers/entra-id/discover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      const result = await r.json();
      setUserAttrCatalog(result);

      // Pre-select default attributes if user hasn't picked any yet (fresh wizard, no initialConfig)
      const available = new Set(result.attributes || []);
      if (!isEdit && !initialConfig?.identityAttributes && identityAttrs.length === 0) {
        setIdentityAttrs(DEFAULT_IDENTITY_ATTRS.filter(a => available.has(a)));
      }
      if (!isEdit && !initialConfig?.customUserAttributes && customUserAttrs.length === 0) {
        setCustomUserAttrs(DEFAULT_USER_ATTRS.filter(a => available.has(a)));
      }
    } catch (err) {
      setUserAttrCatalog({ attributes: [], populated: {}, error: err.message });
    } finally {
      setDiscovering(false);
    }
  };
  const ensureGroupAttrs = async () => {
    if (groupAttrCatalog || discovering) return;
    setDiscovering(true);
    try {
      const body = isEdit && !clientSecret.trim()
        ? { type: 'groups', configId: initialConfig?.id }
        : { type: 'groups', config: { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() } };
      const r = await authFetch('/api/admin/crawlers/entra-id/discover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      const result = await r.json();
      setGroupAttrCatalog(result);

      // Pre-select default group attributes if user hasn't picked any yet
      const available = new Set(result.attributes || []);
      if (!isEdit && !initialConfig?.customGroupAttributes && customGroupAttrs.length === 0) {
        setCustomGroupAttrs(DEFAULT_GROUP_ATTRS.filter(a => available.has(a)));
      }
    } catch (err) {
      setGroupAttrCatalog({ attributes: [], populated: {}, error: err.message });
    } finally {
      setDiscovering(false);
    }
  };

  useEffect(() => {
    if (step === 3) ensureUserAttrs();
    if (step === 4) { ensureUserAttrs(); ensureGroupAttrs(); }
  }, [step]);

  const toggleObject = (key) => setSelectedObjects(prev => ({ ...prev, [key]: !prev[key] }));

  const canObjectBeSelected = (key) => {
    if (!validation?.permissionObjectMap) return true;
    const reqPerms = Object.entries(validation.permissionObjectMap)
      .filter(([, types]) => types.includes(key))
      .map(([p]) => p);
    return reqPerms.length === 0 || reqPerms.some(p => validation.permissions?.[p]);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const { displayName, configPayload } = buildEntraConfigPayload({
        crawlerName, organization: validation?.organization, tenantId, clientId, clientSecret,
        selectedObjects, identityAttrs, customUserAttrs, customGroupAttrs, schedules,
        idFilterEnabled, idFilterAttr, idFilterCondition, idFilterValue,
        signInLogsDays, aiNamePatterns,
      });

      let r;
      if (initialConfig?.id) {
        r = await authFetch(`/api/admin/crawler-configs/${initialConfig.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName, config: configPayload }),
        });
      } else {
        r = await authFetch('/api/admin/crawler-configs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ crawlerType: 'entra-id', displayName, config: configPayload }),
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

  // ── Render ────────────────────────────────────────────────────

  // Authoritative catalog from a fresh validate, else the static fallback so
  // edit mode (no re-validation) still shows every selectable object type.
  const objectTypesCatalog = validation?.objectTypes?.length ? validation.objectTypes : ENTRA_OBJECT_TYPES_FALLBACK;

  const entraSteps = [
    { n: 1, label: 'Credentials' },
    { n: 2, label: 'Object Types' },
    { n: 3, label: 'Identity', shown: stepNeeded(3) },
    { n: 4, label: 'Users & Groups', shown: stepNeeded(4) },
    { n: 5, label: 'Schedule' },
  ];

  return (
    <WizardShell
      title={`${isEdit ? 'Edit' : 'Add'} Microsoft Graph Crawler`}
      onCancel={onCancel}
      steps={entraSteps}
      currentStep={step}
      onStepClick={setStep}
      allowAllSteps={isEdit}
      error={error}
    >

      {/* ─── Step 1: Name + Credentials ─────────────────────────── */}
      {step === 1 && (
        <div>
          <p className="text-sm text-gray-500 mb-4 dark:text-gray-400">
            Enter a name for this crawler and your App Registration credentials. We'll validate them and check which permissions are granted.
          </p>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1 dark:text-gray-200">Crawler Name *</label>
            <input type="text" value={crawlerName} onChange={e => setCrawlerName(e.target.value)}
              placeholder="e.g., Entra ID — Production"
              className="w-full max-w-md p-2 border border-gray-200 rounded text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium mb-1 dark:text-gray-200">Tenant ID *</label>
              <input type="text" value={tenantId} onChange={e => setTenantId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="w-full p-2 border border-gray-200 rounded font-mono text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 dark:text-gray-200">Client ID *</label>
              <input type="text" value={clientId} onChange={e => setClientId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="w-full p-2 border border-gray-200 rounded font-mono text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 dark:text-gray-200">
                Client Secret {isEdit ? '(leave blank to keep)' : '*'}
              </label>
              <input type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)}
                placeholder={isEdit ? '••••••••' : 'Enter client secret'}
                className="w-full p-2 border border-gray-200 rounded text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
            </div>
          </div>
          {validationError && (
            <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300">{validationError}</div>
          )}
          <div className="flex justify-end">
            <button onClick={handleValidate}
              disabled={validating || !tenantId.trim() || !clientId.trim() || (!isEdit && !clientSecret.trim()) || !crawlerName.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
              {validating ? 'Validating...' : (isEdit && !clientSecret.trim() ? 'Next' : 'Validate & Next')}
            </button>
          </div>
        </div>
      )}

      {/* ─── Step 2: Object Type Selection ──────────────────────── */}
      {step === 2 && (validation || isEdit) && (
        <div>
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded dark:bg-green-900/20 dark:border-green-700">
            <span className="font-medium text-green-800 dark:text-green-300">
              Connected to {validation?.organization || 'tenant'}
            </span>
          </div>

          {Object.keys(validation?.permissions || {}).length > 0 ? (
            <div className="mb-5">
              <h4 className="text-sm font-semibold mb-2 dark:text-gray-200">Granted Permissions</h4>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
                {Object.entries(validation.permissions || {}).sort(([a], [b]) => a.localeCompare(b)).map(([perm, granted]) => (
                  <div key={perm} className="flex items-center gap-2 text-sm py-1">
                    <span className={granted ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>{granted ? '✓' : '✗'}</span>
                    <span className={granted ? 'dark:text-gray-200' : 'text-gray-600 line-through dark:text-gray-500'}>{perm}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="mb-5 text-xs text-gray-500 dark:text-gray-400">
              Permissions weren't re-checked (no new client secret entered). Re-enter the secret on the previous step to verify Graph permissions — object types are still selectable here. Make sure the app has the permissions a type needs before enabling it.
            </div>
          )}

          <div className="mb-5">
            <h4 className="text-sm font-semibold mb-2 dark:text-gray-200">Object Types to Sync</h4>
            <div className="space-y-2">
              {objectTypesCatalog.map(ot => {
                const canSelect = canObjectBeSelected(ot.key);
                return (
                  <label key={ot.key} className={`flex items-start gap-3 p-2 rounded ${canSelect ? '' : 'opacity-40'}`}>
                    <input type="checkbox" checked={selectedObjects[ot.key] || false}
                      onChange={() => canSelect && toggleObject(ot.key)} disabled={!canSelect}
                      className="mt-0.5 rounded" />
                    <div>
                      <span className="text-sm font-medium dark:text-gray-200">{ot.label}</span>
                      <span className="text-xs text-gray-500 ml-2 dark:text-gray-400">{ot.description}</span>
                      {!canSelect && <span className="text-xs text-red-600 ml-2">(missing permissions)</span>}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex justify-between">
            <button onClick={prevStep} className="px-4 py-2 bg-gray-200 rounded text-sm dark:bg-gray-700 dark:text-gray-300">Back</button>
            <button onClick={nextStep} className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">Next</button>
          </div>
        </div>
      )}

      {/* ─── Step 3: Identity Configuration ─────────────────────── */}
      {step === 3 && (
        <div>
          <h4 className="text-sm font-semibold mb-3 dark:text-gray-200">Identity Configuration</h4>

          {/* Identity filter */}
          <div className="mb-5 p-4 bg-gray-50 rounded border border-gray-200 dark:bg-gray-700/50 dark:border-gray-600">
            <div className="flex items-center gap-3 mb-3">
              <input type="checkbox" checked={idFilterEnabled} onChange={e => setIdFilterEnabled(e.target.checked)} className="rounded" />
              <h5 className="text-sm font-semibold dark:text-gray-200">Identity Filter</h5>
            </div>
            <p className="text-xs text-gray-500 mb-3 dark:text-gray-400">Select which users should be synced as identities. Users not matching the filter will be skipped from the identities table.</p>

            {idFilterEnabled && (
              <div className="ml-6 grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1 dark:text-gray-300">Attribute</label>
                  {discovering ? (
                    <div className="text-xs text-gray-500 dark:text-gray-400">Discovering...</div>
                  ) : userAttrCatalog?.attributes?.length > 0 ? (
                    <select value={idFilterAttr} onChange={e => setIdFilterAttr(e.target.value)}
                      className="w-full p-2 border border-gray-200 rounded text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
                      {userAttrCatalog.attributes.map(a => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </select>
                  ) : (
                    <input type="text" value={idFilterAttr} onChange={e => setIdFilterAttr(e.target.value)}
                      className="w-full p-2 border border-gray-200 rounded text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200" />
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1 dark:text-gray-300">Condition</label>
                  <select value={idFilterCondition} onChange={e => setIdFilterCondition(e.target.value)}
                    className="w-full p-2 border border-gray-200 rounded text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
                    <option value="isNotNull">Is not empty</option>
                    <option value="equals">Equals</option>
                    <option value="notEquals">Not equals</option>
                    <option value="inValues">In values (comma-separated)</option>
                  </select>
                </div>
                {idFilterCondition !== 'isNotNull' && (() => {
                  const filterType = userAttrCatalog?.dataTypes?.[idFilterAttr];
                  const isBool = filterType === 'Boolean';
                  return (
                    <div>
                      <label className="block text-xs font-medium mb-1 dark:text-gray-300">
                        Value{filterType && <span className="ml-1 text-gray-600 dark:text-gray-500">({filterType})</span>}
                      </label>
                      {isBool && idFilterCondition !== 'inValues' ? (
                        <select value={idFilterValue || 'true'} onChange={e => setIdFilterValue(e.target.value)}
                          className="w-full p-2 border border-gray-200 rounded text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input type="text" value={idFilterValue} onChange={e => setIdFilterValue(e.target.value)}
                          placeholder={idFilterCondition === 'inValues' ? 'a, b, c' : 'value'}
                          className="w-full p-2 border border-gray-200 rounded text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Identity attributes to sync */}
          <div className="mb-5 p-4 bg-gray-50 rounded border border-gray-200 dark:bg-gray-700/50 dark:border-gray-600">
            <h5 className="text-sm font-semibold mb-2 dark:text-gray-200">Identity Attributes to Sync</h5>
            <p className="text-xs text-gray-500 mb-3 dark:text-gray-400">Pick which user attributes get stored in extendedAttributes JSON for identities. Core fields (displayName, email, employeeId) are always included.</p>
            {discovering && !userAttrCatalog && <div className="text-sm text-gray-500 dark:text-gray-400">Discovering attributes from Microsoft Graph...</div>}
            {userAttrCatalog?.error && <div className="text-sm text-red-500 dark:text-red-400">Discovery failed: {userAttrCatalog.error}</div>}
            {userAttrCatalog?.attributes && (
              <AttributePicker
                title="Identity attributes"
                available={userAttrCatalog.attributes}
                selected={identityAttrs}
                onChange={setIdentityAttrs}
                coreAttrs={CORE_USER_ATTRS}
              />
            )}
          </div>

          <div className="flex justify-between">
            <button onClick={prevStep} className="px-4 py-2 bg-gray-200 rounded text-sm dark:bg-gray-700 dark:text-gray-300">Back</button>
            <button onClick={nextStep} className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">Next</button>
          </div>
        </div>
      )}

      {/* ─── Step 4: Users & Groups Attributes ──────────────────── */}
      {step === 4 && (
        <div>
          <h4 className="text-sm font-semibold mb-3 dark:text-gray-200">User & Group Attributes</h4>
          <p className="text-xs text-gray-500 mb-3 dark:text-gray-400">Pick which attributes to fetch. Core fields (displayName, givenName, surname, mail, etc.) are always synced and shown locked.</p>

          {discovering && (!userAttrCatalog || !groupAttrCatalog) && (
            <div className="text-sm text-gray-500 mb-3 dark:text-gray-400">Discovering attributes from Microsoft Graph...</div>
          )}
          {userAttrCatalog?.attributes && (
            <div className="mb-4 p-4 bg-gray-50 rounded border border-gray-200 dark:bg-gray-700/50 dark:border-gray-600">
              <AttributePicker
                title="User attributes"
                available={userAttrCatalog.attributes}
                selected={customUserAttrs}
                onChange={setCustomUserAttrs}
                coreAttrs={CORE_USER_ATTRS}
              />
            </div>
          )}
          {groupAttrCatalog?.attributes && (
            <div className="mb-4 p-4 bg-gray-50 rounded border border-gray-200 dark:bg-gray-700/50 dark:border-gray-600">
              <AttributePicker
                title="Group attributes"
                available={groupAttrCatalog.attributes}
                selected={customGroupAttrs}
                onChange={setCustomGroupAttrs}
                coreAttrs={CORE_GROUP_ATTRS}
              />
            </div>
          )}

          <div className="flex justify-between">
            <button onClick={prevStep} className="px-4 py-2 bg-gray-200 rounded text-sm dark:bg-gray-700 dark:text-gray-300">Back</button>
            <button onClick={nextStep} className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">Next</button>
          </div>
        </div>
      )}

      {/* ─── Step 5: Schedules ──────────────────────────────────── */}
      {step === 5 && (
        <div>
          <h4 className="text-sm font-semibold mb-3 dark:text-gray-200">Schedule</h4>
          <p className="text-xs text-gray-500 mb-3 dark:text-gray-400">Configure when this crawler runs automatically. You can add multiple schedules (e.g., a hourly delta + a daily full sync).</p>

          {schedules.length === 0 && (
            <div className="mb-3 p-4 bg-gray-50 border border-gray-200 rounded text-center text-sm text-gray-500 dark:bg-gray-700/50 dark:border-gray-600 dark:text-gray-400">
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

          <button onClick={() => setSchedules([...schedules, { enabled: true, frequency: 'daily', hour: 2, minute: 0 }])}
            className="mb-4 px-3 py-1.5 text-xs bg-gray-200 rounded hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
            + Add Schedule
          </button>

          {/* ─── Advanced options ──────────────────────────────── */}
          <div className="mt-4 mb-4 border-t pt-4 dark:border-gray-700">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-sm text-gray-700 hover:text-gray-900 flex items-center gap-1 dark:text-gray-300 dark:hover:text-white"
            >
              <span className={`inline-block transition-transform ${showAdvanced ? 'rotate-90' : ''}`}>▶</span>
              Advanced options
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-4 p-4 bg-gray-50 border border-gray-200 rounded dark:bg-gray-800 dark:border-gray-700">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1 dark:text-gray-300">
                    Sign-in logs window (days)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="30"
                    value={signInLogsDays}
                    onChange={e => setSignInLogsDays(e.target.value)}
                    className="w-24 px-2 py-1 text-sm border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  />
                  <p className="text-xs text-gray-500 mt-1 dark:text-gray-400">
                    How many days of <code>/auditLogs/signIns</code> to fetch per run. Graph retains events for up to 30 days; default is 7 so daily runs overlap a day.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1 dark:text-gray-300">
                    Extra AI-agent name patterns (one regex per line)
                  </label>
                  <textarea
                    rows={4}
                    value={aiNamePatterns}
                    onChange={e => setAiNamePatterns(e.target.value)}
                    placeholder="e.g. mycustom.*copilot&#10;\bassistant\b"
                    className="w-full px-2 py-1 text-sm font-mono border border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  />
                  <p className="text-xs text-gray-500 mt-1 dark:text-gray-400">
                    Combined with the built-in list (copilot, openai, bot, azure-ai, gpt, …). Case-insensitive. Matches on <code>servicePrincipal.displayName</code>. Leave empty to use the default set.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-between border-t pt-4 dark:border-gray-700">
            <button onClick={prevStep} className="px-4 py-2 bg-gray-200 rounded text-sm dark:bg-gray-700 dark:text-gray-300">Back</button>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving...' : (isEdit ? 'Save Changes' : 'Deploy to Worker')}
            </button>
          </div>
        </div>
      )}
    </WizardShell>
  );
}
