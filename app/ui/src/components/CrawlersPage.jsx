import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../auth/AuthGate';

const SECRET_MASK = '••••••••';

// Format a duration in seconds as e.g. "1h 37m 17s" / "2m 8s" / "12s".
function formatDurationHMS(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return s > 0 ? `${h}h ${m}m ${s}s` : `${h}h ${m}m`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ─── Crawler type catalog ─────────────────────────────────────────────────────
const CRAWLER_TYPES = [
  {
    id: 'entra-id',
    name: 'Microsoft Graph',
    description: 'Sync users, groups, roles, and governance data from Entra ID',
    available: true,
  },
  {
    id: 'csv',
    name: 'CSV Import',
    description: 'Upload semicolon-delimited CSV files exported from Omada, SailPoint, or other IGA systems',
    available: true,
  },
  {
    id: 'demo',
    name: 'Demo Data',
    description: 'Load synthetic data to explore the platform (~30 seconds)',
    available: true, immediate: true,
  },
  {
    id: 'custom',
    name: 'Custom Crawler',
    description: 'Connect your own crawler using the Ingest API',
    available: false, comingSoon: true,
  },
];

// ─── Step 1: Select Type ──────────────────────────────────────────────────────
function SelectType({ onSelect, onCancel }) {
  return (
    <div className="mb-6 p-5 bg-white border rounded-lg">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Add Crawler — Select Type</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-700 text-sm">Cancel</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {CRAWLER_TYPES.map(t => (
          <button
            key={t.id}
            onClick={() => t.available && onSelect(t.id)}
            disabled={!t.available}
            className={`flex flex-col items-start p-4 rounded-lg border-2 text-left transition-all ${
              t.available
                ? 'border-gray-200 hover:border-indigo-400 hover:shadow-md cursor-pointer'
                : 'border-gray-100 opacity-50 cursor-not-allowed'
            }`}
          >
            <span className="font-semibold text-gray-900">{t.name}</span>
            <span className="text-sm text-gray-500 mt-1">{t.description}</span>
            {t.comingSoon && (
              <span className="mt-2 px-2 py-0.5 bg-gray-100 text-gray-500 text-xs rounded-full">Coming soon</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Attribute Picker (used in Identity, Users & Groups pages) ────────────────
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
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-2">
        <h5 className="text-xs font-semibold text-gray-700">
          {title} ({selected.length} extra + {coreAttrs.length} core)
        </h5>
        <input type="text" value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="Filter..."
          className="px-2 py-1 text-xs border rounded w-48" />
      </div>
      <div className="max-h-72 overflow-y-auto border rounded bg-white">
        {visible.length === 0 ? (
          <div className="text-xs text-gray-400 italic p-2">No attributes match filter</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {visible.map(attr => {
              const isCore = coreSet.has(attr);
              const isSelected = isCore || selected.includes(attr);
              return (
                <label key={attr}
                  className={`flex items-center gap-2 text-xs px-2 py-1 ${
                    isCore ? 'cursor-default bg-indigo-50/40' : 'cursor-pointer hover:bg-gray-50'
                  }`}
                  title={isCore ? 'Core attribute (always synced)' : attr}>
                  <input type="checkbox" checked={isSelected} disabled={isCore}
                    onChange={() => toggle(attr)} className="rounded flex-shrink-0" />
                  <span className="truncate">{attr}</span>
                  {isCore && <span className="text-indigo-500 text-[10px] flex-shrink-0">core</span>}
                </label>
              );
            })}
          </div>
        )}
      </div>
      <p className="text-xs text-gray-400 mt-1">
        <span className="text-indigo-500">core</span> = always synced.
        Extras go into the extendedAttributes JSON column.
      </p>
    </div>
  );
}

// ─── Schedule Editor (one schedule entry) ─────────────────────────────────────
function ScheduleEditor({ schedule, onChange, onRemove }) {
  const update = (field, value) => onChange({ ...schedule, [field]: value });
  return (
    <div className="p-3 bg-white border rounded mb-2">
      <div className="grid grid-cols-5 gap-2 items-end">
        <div>
          <label className="block text-xs font-medium mb-1">Frequency</label>
          <select value={schedule.frequency || 'daily'} onChange={e => update('frequency', e.target.value)}
            className="w-full p-2 border rounded text-sm">
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>
        {schedule.frequency !== 'hourly' && (
          <div>
            <label className="block text-xs font-medium mb-1">Hour (UTC)</label>
            <select value={schedule.hour ?? 2} onChange={e => update('hour', parseInt(e.target.value, 10))}
              className="w-full p-2 border rounded text-sm">
              {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs font-medium mb-1">Minute</label>
          <select value={schedule.minute ?? 0} onChange={e => update('minute', parseInt(e.target.value, 10))}
            className="w-full p-2 border rounded text-sm">
            {[0, 15, 30, 45].map(m => <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>)}
          </select>
        </div>
        {schedule.frequency === 'weekly' && (
          <div>
            <label className="block text-xs font-medium mb-1">Day</label>
            <select value={schedule.day ?? 0} onChange={e => update('day', parseInt(e.target.value, 10))}
              className="w-full p-2 border rounded text-sm">
              {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
        )}
        <button onClick={onRemove} className="px-2 py-2 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 self-end">Remove</button>
      </div>
    </div>
  );
}

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

// ─── Entra ID Wizard (multi-step) ─────────────────────────────────────────────
//
// Steps:
//   1. Name + Credentials → Validate
//   2. Object Type Selection
//   3. Identity (filter + attributes) — only if `identity` selected
//   4. Users & Groups (attributes) — only if `usersGroupsMembers` selected
//   5. Schedules (multiple)
//
// `initialConfig` is provided in edit mode to pre-populate all fields.
function EntraIdWizard({ onComplete, onCancel, validateFn, discoverFn, initialConfig, isEdit }) {
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

  // User/group attributes
  const [customUserAttrs, setCustomUserAttrs] = useState(initialConfig?.customUserAttributes || []);
  const [customGroupAttrs, setCustomGroupAttrs] = useState(initialConfig?.customGroupAttributes || []);

  // Schedules (array)
  const [schedules, setSchedules] = useState(() => {
    if (initialConfig?.schedules?.length) return initialConfig.schedules;
    if (initialConfig?.schedule) return [initialConfig.schedule];
    return [];
  });

  // Discovery state
  const [userAttrCatalog, setUserAttrCatalog] = useState(null);
  const [groupAttrCatalog, setGroupAttrCatalog] = useState(null);
  const [discovering, setDiscovering] = useState(false);

  const [saving, setSaving] = useState(false);

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
      const result = await validateFn({
        tenantId: tenantId.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
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
      const result = await discoverFn({
        tenantId: tenantId.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        configId: isEdit && !clientSecret.trim() ? initialConfig?.id : undefined,
        type: 'users',
      });
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
      const result = await discoverFn({
        tenantId: tenantId.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        configId: isEdit && !clientSecret.trim() ? initialConfig?.id : undefined,
        type: 'groups',
      });
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
    const config = {
      displayName: crawlerName.trim() || `Entra ID — ${validation?.organization || 'Unnamed'}`,
      credentials: {
        tenantId: tenantId.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(), // empty string in edit mode if unchanged
      },
      selectedObjects,
      identityAttributes: identityAttrs,
      customUserAttributes: customUserAttrs,
      customGroupAttributes: customGroupAttrs,
      schedules,
    };
    if (idFilterEnabled && selectedObjects.identity) {
      config.identityFilter = { attribute: idFilterAttr, condition: idFilterCondition };
      if (idFilterCondition === 'equals' || idFilterCondition === 'notEquals') {
        config.identityFilter.value = idFilterValue;
      }
      if (idFilterCondition === 'inValues') {
        config.identityFilter.values = idFilterValue.split(',').map(s => s.trim()).filter(Boolean);
      }
    }
    try {
      await onComplete(config);
    } finally {
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────

  const renderStepIndicator = () => {
    const steps = [
      { n: 1, label: 'Credentials' },
      { n: 2, label: 'Object Types' },
      { n: 3, label: 'Identity', shown: stepNeeded(3) },
      { n: 4, label: 'Users & Groups', shown: stepNeeded(4) },
      { n: 5, label: 'Schedule' },
    ];
    return (
      <div className="flex items-center gap-2 mb-5 text-xs">
        {steps.filter(s => s.shown !== false).map((s, i, arr) => (
          <div key={s.n} className="flex items-center gap-2">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center font-semibold ${
              s.n === step ? 'bg-indigo-600 text-white' :
              s.n < step ? 'bg-indigo-100 text-indigo-700' :
              'bg-gray-200 text-gray-500'
            }`}>{i + 1}</div>
            <span className={s.n === step ? 'font-medium text-gray-900' : 'text-gray-500'}>{s.label}</span>
            {i < arr.length - 1 && <span className="text-gray-300">→</span>}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="mb-6 p-5 bg-white border rounded-lg">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">{isEdit ? 'Edit' : 'Add'} Microsoft Graph Crawler</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-700 text-sm">Cancel</button>
      </div>

      {renderStepIndicator()}

      {/* ─── Step 1: Name + Credentials ─────────────────────────── */}
      {step === 1 && (
        <div>
          <p className="text-sm text-gray-500 mb-4">
            Enter a name for this crawler and your App Registration credentials. We'll validate them and check which permissions are granted.
          </p>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">Crawler Name *</label>
            <input type="text" value={crawlerName} onChange={e => setCrawlerName(e.target.value)}
              placeholder="e.g., Entra ID — Production"
              className="w-full max-w-md p-2 border rounded text-sm" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium mb-1">Tenant ID *</label>
              <input type="text" value={tenantId} onChange={e => setTenantId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="w-full p-2 border rounded font-mono text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Client ID *</label>
              <input type="text" value={clientId} onChange={e => setClientId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="w-full p-2 border rounded font-mono text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                Client Secret {isEdit ? '(leave blank to keep)' : '*'}
              </label>
              <input type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)}
                placeholder={isEdit ? '••••••••' : 'Enter client secret'}
                className="w-full p-2 border rounded text-sm" />
            </div>
          </div>
          {validationError && (
            <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">{validationError}</div>
          )}
          <div className="flex justify-end">
            <button onClick={handleValidate}
              disabled={validating || !tenantId.trim() || !clientId.trim() || (!isEdit && !clientSecret.trim()) || !crawlerName.trim()}
              className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50">
              {validating ? 'Validating...' : (isEdit && !clientSecret.trim() ? 'Next' : 'Validate & Next')}
            </button>
          </div>
        </div>
      )}

      {/* ─── Step 2: Object Type Selection ──────────────────────── */}
      {step === 2 && validation && (
        <div>
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded">
            <span className="font-medium text-green-800">
              Connected to {validation.organization || 'tenant'}
            </span>
          </div>

          <div className="mb-5">
            <h4 className="text-sm font-semibold mb-2">Granted Permissions</h4>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
              {Object.entries(validation.permissions || {}).sort(([a], [b]) => a.localeCompare(b)).map(([perm, granted]) => (
                <div key={perm} className="flex items-center gap-2 text-sm py-1">
                  <span className={granted ? 'text-green-600' : 'text-red-400'}>{granted ? '✓' : '✗'}</span>
                  <span className={granted ? '' : 'text-gray-400 line-through'}>{perm}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mb-5">
            <h4 className="text-sm font-semibold mb-2">Object Types to Sync</h4>
            <div className="space-y-2">
              {(validation.objectTypes || []).map(ot => {
                const canSelect = canObjectBeSelected(ot.key);
                return (
                  <label key={ot.key} className={`flex items-start gap-3 p-2 rounded ${canSelect ? '' : 'opacity-40'}`}>
                    <input type="checkbox" checked={selectedObjects[ot.key] || false}
                      onChange={() => canSelect && toggleObject(ot.key)} disabled={!canSelect}
                      className="mt-0.5 rounded" />
                    <div>
                      <span className="text-sm font-medium">{ot.label}</span>
                      <span className="text-xs text-gray-500 ml-2">{ot.description}</span>
                      {!canSelect && <span className="text-xs text-red-400 ml-2">(missing permissions)</span>}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex justify-between">
            <button onClick={prevStep} className="px-4 py-2 bg-gray-200 rounded text-sm">Back</button>
            <button onClick={nextStep} className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700">Next</button>
          </div>
        </div>
      )}

      {/* ─── Step 3: Identity Configuration ─────────────────────── */}
      {step === 3 && (
        <div>
          <h4 className="text-sm font-semibold mb-3">Identity Configuration</h4>

          {/* Identity filter */}
          <div className="mb-5 p-4 bg-gray-50 rounded border">
            <div className="flex items-center gap-3 mb-3">
              <input type="checkbox" checked={idFilterEnabled} onChange={e => setIdFilterEnabled(e.target.checked)} className="rounded" />
              <h5 className="text-sm font-semibold">Identity Filter</h5>
            </div>
            <p className="text-xs text-gray-500 mb-3">Select which users should be synced as identities. Users not matching the filter will be skipped from the identities table.</p>

            {idFilterEnabled && (
              <div className="ml-6 grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Attribute</label>
                  {discovering ? (
                    <div className="text-xs text-gray-500">Discovering...</div>
                  ) : userAttrCatalog?.attributes?.length > 0 ? (
                    <select value={idFilterAttr} onChange={e => setIdFilterAttr(e.target.value)}
                      className="w-full p-2 border rounded text-sm">
                      {userAttrCatalog.attributes.map(a => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </select>
                  ) : (
                    <input type="text" value={idFilterAttr} onChange={e => setIdFilterAttr(e.target.value)}
                      className="w-full p-2 border rounded text-sm" />
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Condition</label>
                  <select value={idFilterCondition} onChange={e => setIdFilterCondition(e.target.value)}
                    className="w-full p-2 border rounded text-sm">
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
                      <label className="block text-xs font-medium mb-1">
                        Value{filterType && <span className="ml-1 text-gray-400">({filterType})</span>}
                      </label>
                      {isBool && idFilterCondition !== 'inValues' ? (
                        <select value={idFilterValue || 'true'} onChange={e => setIdFilterValue(e.target.value)}
                          className="w-full p-2 border rounded text-sm">
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input type="text" value={idFilterValue} onChange={e => setIdFilterValue(e.target.value)}
                          placeholder={idFilterCondition === 'inValues' ? 'a, b, c' : 'value'}
                          className="w-full p-2 border rounded text-sm" />
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Identity attributes to sync */}
          <div className="mb-5 p-4 bg-gray-50 rounded border">
            <h5 className="text-sm font-semibold mb-2">Identity Attributes to Sync</h5>
            <p className="text-xs text-gray-500 mb-3">Pick which user attributes get stored in extendedAttributes JSON for identities. Core fields (displayName, email, employeeId) are always included.</p>
            {discovering && !userAttrCatalog && <div className="text-sm text-gray-500">Discovering attributes from Microsoft Graph...</div>}
            {userAttrCatalog?.error && <div className="text-sm text-red-500">Discovery failed: {userAttrCatalog.error}</div>}
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
            <button onClick={prevStep} className="px-4 py-2 bg-gray-200 rounded text-sm">Back</button>
            <button onClick={nextStep} className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700">Next</button>
          </div>
        </div>
      )}

      {/* ─── Step 4: Users & Groups Attributes ──────────────────── */}
      {step === 4 && (
        <div>
          <h4 className="text-sm font-semibold mb-3">User & Group Attributes</h4>
          <p className="text-xs text-gray-500 mb-3">Pick which attributes to fetch. Core fields (displayName, givenName, surname, mail, etc.) are always synced and shown locked.</p>

          {discovering && (!userAttrCatalog || !groupAttrCatalog) && (
            <div className="text-sm text-gray-500 mb-3">Discovering attributes from Microsoft Graph...</div>
          )}
          {userAttrCatalog?.attributes && (
            <div className="mb-4 p-4 bg-gray-50 rounded border">
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
            <div className="mb-4 p-4 bg-gray-50 rounded border">
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
            <button onClick={prevStep} className="px-4 py-2 bg-gray-200 rounded text-sm">Back</button>
            <button onClick={nextStep} className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700">Next</button>
          </div>
        </div>
      )}

      {/* ─── Step 5: Schedules ──────────────────────────────────── */}
      {step === 5 && (
        <div>
          <h4 className="text-sm font-semibold mb-3">Schedule</h4>
          <p className="text-xs text-gray-500 mb-3">Configure when this crawler runs automatically. You can add multiple schedules (e.g., a hourly delta + a daily full sync).</p>

          {schedules.length === 0 && (
            <div className="mb-3 p-4 bg-gray-50 border rounded text-center text-sm text-gray-500">
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
            className="mb-4 px-3 py-1.5 text-xs bg-gray-200 rounded hover:bg-gray-300">
            + Add Schedule
          </button>

          <div className="flex justify-between border-t pt-4">
            <button onClick={prevStep} className="px-4 py-2 bg-gray-200 rounded text-sm">Back</button>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50">
              {saving ? 'Saving...' : (isEdit ? 'Save Changes' : 'Deploy to Worker')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── (Legacy) Validation + Deploy — kept temporarily during transition ────────
function ValidationAndDeploy({ validation, credentials, onDeploy, onCancel, loading }) {
  const [selectedObjects, setSelectedObjects] = useState({});
  const [crawlerName, setCrawlerName] = useState('');
  // Custom attributes
  const [customUserAttrs, setCustomUserAttrs] = useState('');
  const [customGroupAttrs, setCustomGroupAttrs] = useState('');
  // Identity filter
  const [idFilterEnabled, setIdFilterEnabled] = useState(false);
  const [idFilterAttr, setIdFilterAttr] = useState('employeeId');
  const [idFilterCondition, setIdFilterCondition] = useState('isNotNull');
  const [idFilterValue, setIdFilterValue] = useState('');
  // Schedule
  const [schedEnabled, setSchedEnabled] = useState(false);
  const [schedFrequency, setSchedFrequency] = useState('daily');
  const [schedHour, setSchedHour] = useState(2);
  const [schedMinute, setSchedMinute] = useState(0);
  const [schedDay, setSchedDay] = useState(0);

  // Initialize selections based on available permissions
  useEffect(() => {
    if (!validation?.objectTypes) return;
    const initial = {};
    for (const ot of validation.objectTypes) {
      // Pre-check if the required permissions are granted
      const requiredPerms = Object.entries(validation.permissionObjectMap || {})
        .filter(([, types]) => types.includes(ot.key))
        .map(([perm]) => perm);
      const hasPerms = requiredPerms.length === 0 || requiredPerms.some(p => validation.permissions?.[p]);
      initial[ot.key] = hasPerms;
    }
    setSelectedObjects(initial);
  }, [validation]);

  const toggleObject = (key) => {
    setSelectedObjects(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const canObjectBeSelected = (key) => {
    if (!validation?.permissionObjectMap) return true;
    const requiredPerms = Object.entries(validation.permissionObjectMap)
      .filter(([, types]) => types.includes(key))
      .map(([perm]) => perm);
    return requiredPerms.length === 0 || requiredPerms.some(p => validation.permissions?.[p]);
  };

  const handleDeploy = () => {
    const config = {
      displayName: crawlerName.trim() || `Entra ID — ${validation.organization || 'Unnamed'}`,
      credentials,
      selectedObjects,
    };
    // Custom attributes (comma-separated → array)
    const userAttrs = customUserAttrs.split(',').map(s => s.trim()).filter(Boolean);
    const groupAttrs = customGroupAttrs.split(',').map(s => s.trim()).filter(Boolean);
    if (userAttrs.length > 0) config.customUserAttributes = userAttrs;
    if (groupAttrs.length > 0) config.customGroupAttributes = groupAttrs;
    // Identity filter
    if (idFilterEnabled && selectedObjects.identity) {
      config.identityFilter = { attribute: idFilterAttr, condition: idFilterCondition };
      if (idFilterCondition === 'equals' || idFilterCondition === 'notEquals') {
        config.identityFilter.value = idFilterValue;
      }
      if (idFilterCondition === 'inValues') {
        config.identityFilter.values = idFilterValue.split(',').map(s => s.trim()).filter(Boolean);
      }
    }
    // Schedule
    if (schedEnabled) {
      config.schedule = { enabled: true, frequency: schedFrequency, hour: schedHour, minute: schedMinute };
      if (schedFrequency === 'weekly') config.schedule.day = schedDay;
    }
    onDeploy(config);
  };

  const permEntries = Object.entries(validation.permissions || {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="mb-6 p-5 bg-white border rounded-lg">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Microsoft Graph — Configure</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-700 text-sm">Cancel</button>
      </div>

      {/* Validation result */}
      <div className="mb-5 p-3 bg-green-50 border border-green-200 rounded">
        <span className="font-medium text-green-800">
          Connected to {validation.organization || 'tenant'}
        </span>
      </div>

      {/* Permissions checklist */}
      <div className="mb-5">
        <h4 className="text-sm font-semibold mb-2">Granted Permissions</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
          {permEntries.map(([perm, granted]) => (
            <div key={perm} className="flex items-center gap-2 text-sm py-1">
              <span className={granted ? 'text-green-600' : 'text-red-400'}>{granted ? '>' : 'x'}</span>
              <span className={granted ? '' : 'text-gray-400 line-through'}>{perm}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Object type selection */}
      <div className="mb-5">
        <h4 className="text-sm font-semibold mb-2">Object Types to Sync</h4>
        <div className="space-y-2">
          {(validation.objectTypes || []).map(ot => {
            const canSelect = canObjectBeSelected(ot.key);
            return (
              <label key={ot.key} className={`flex items-start gap-3 p-2 rounded ${canSelect ? '' : 'opacity-40'}`}>
                <input
                  type="checkbox"
                  checked={selectedObjects[ot.key] || false}
                  onChange={() => canSelect && toggleObject(ot.key)}
                  disabled={!canSelect}
                  className="mt-0.5 rounded"
                />
                <div>
                  <span className="text-sm font-medium">{ot.label}</span>
                  <span className="text-xs text-gray-500 ml-2">{ot.description}</span>
                  {!canSelect && <span className="text-xs text-red-400 ml-2">(missing permissions)</span>}
                </div>
              </label>
            );
          })}
        </div>
      </div>

      {/* Identity filter (shown when Identity object type is selected) */}
      {selectedObjects.identity && (
        <div className="mb-5 p-4 bg-gray-50 rounded border">
          <div className="flex items-center gap-3 mb-3">
            <input type="checkbox" checked={idFilterEnabled} onChange={e => setIdFilterEnabled(e.target.checked)} className="rounded" />
            <h4 className="text-sm font-semibold">Identity Selection Filter</h4>
          </div>
          {idFilterEnabled && (
            <div className="ml-6 space-y-3">
              <p className="text-xs text-gray-500">Select which users should be treated as identities (e.g., HR-managed accounts).</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Attribute</label>
                  <select value={idFilterAttr} onChange={e => setIdFilterAttr(e.target.value)}
                    className="w-full p-2 border rounded text-sm">
                    <option value="employeeId">employeeId</option>
                    <option value="employeeType">employeeType</option>
                    <option value="companyName">companyName</option>
                    <option value="department">department</option>
                    <option value="onPremisesSyncEnabled">onPremisesSyncEnabled</option>
                    <option value="employeeHireDate">employeeHireDate</option>
                    <option value="accountEnabled">accountEnabled</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Condition</label>
                  <select value={idFilterCondition} onChange={e => setIdFilterCondition(e.target.value)}
                    className="w-full p-2 border rounded text-sm">
                    <option value="isNotNull">Is not empty</option>
                    <option value="equals">Equals</option>
                    <option value="notEquals">Not equals</option>
                    <option value="inValues">In values (comma-separated)</option>
                  </select>
                </div>
                {idFilterCondition !== 'isNotNull' && (
                  <div>
                    <label className="block text-xs font-medium mb-1">Value</label>
                    <input type="text" value={idFilterValue} onChange={e => setIdFilterValue(e.target.value)}
                      placeholder={idFilterCondition === 'inValues' ? 'Employee, Intern, Contractor' : 'Employee'}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Custom attributes */}
      <div className="mb-5 p-4 bg-gray-50 rounded border">
        <h4 className="text-sm font-semibold mb-2">Custom Attributes (optional)</h4>
        <p className="text-xs text-gray-500 mb-3">Add extra attributes to sync from Microsoft Graph. Comma-separated. These will be stored in extendedAttributes.</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium mb-1">User attributes</label>
            <input type="text" value={customUserAttrs} onChange={e => setCustomUserAttrs(e.target.value)}
              placeholder="e.g., employeeHireDate, onPremisesSyncEnabled, extension_abc123_costCenter"
              className="w-full p-2 border rounded text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Group attributes</label>
            <input type="text" value={customGroupAttrs} onChange={e => setCustomGroupAttrs(e.target.value)}
              placeholder="e.g., classification, resourceBehaviorOptions"
              className="w-full p-2 border rounded text-sm" />
          </div>
        </div>
      </div>

      {/* Schedule */}
      <div className="mb-5 p-4 bg-gray-50 rounded border">
        <div className="flex items-center gap-3 mb-3">
          <input type="checkbox" checked={schedEnabled} onChange={e => setSchedEnabled(e.target.checked)} className="rounded" />
          <h4 className="text-sm font-semibold">Schedule</h4>
        </div>
        {schedEnabled && (
          <div className="ml-6 grid grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Frequency</label>
              <select value={schedFrequency} onChange={e => setSchedFrequency(e.target.value)}
                className="w-full p-2 border rounded text-sm">
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            {schedFrequency !== 'hourly' && (
              <div>
                <label className="block text-xs font-medium mb-1">Hour (UTC)</label>
                <select value={schedHour} onChange={e => setSchedHour(parseInt(e.target.value, 10))}
                  className="w-full p-2 border rounded text-sm">
                  {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium mb-1">Minute</label>
              <select value={schedMinute} onChange={e => setSchedMinute(parseInt(e.target.value, 10))}
                className="w-full p-2 border rounded text-sm">
                {[0, 15, 30, 45].map(m => <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>)}
              </select>
            </div>
            {schedFrequency === 'weekly' && (
              <div>
                <label className="block text-xs font-medium mb-1">Day</label>
                <select value={schedDay} onChange={e => setSchedDay(parseInt(e.target.value, 10))}
                  className="w-full p-2 border rounded text-sm">
                  {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Crawler name */}
      <div className="mb-5">
        <label className="block text-sm font-medium mb-1">Crawler Name</label>
        <input type="text" value={crawlerName} onChange={e => setCrawlerName(e.target.value)}
          placeholder={`Entra ID — ${validation.organization || 'Production'}`}
          className="w-full max-w-md p-2 border rounded text-sm" />
      </div>

      {/* Deploy options */}
      <div className="mb-5">
        <h4 className="text-sm font-semibold mb-2">Deploy To</h4>
        <div className="flex gap-3">
          <button
            onClick={handleDeploy}
            disabled={loading}
            className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? 'Saving...' : 'Deploy to Worker'}
          </button>
          <button disabled className="px-4 py-2 bg-gray-100 text-gray-400 rounded text-sm cursor-not-allowed">
            Azure Automation (coming soon)
          </button>
          <button disabled className="px-4 py-2 bg-gray-100 text-gray-400 rounded text-sm cursor-not-allowed">
            Download Scripts (coming soon)
          </button>
        </div>
      </div>

      <button onClick={onCancel} className="text-sm text-gray-500 hover:text-gray-700">Back to type selection</button>
    </div>
  );
}

// ─── Configured Crawler Card (display-only — Configure opens wizard in edit mode) ──
function CrawlerConfigCard({ config, onRunNow, onEdit, onRemove, onForceStop, runningJob }) {
  const cfg = config.config || {};

  const objectLabels = [];
  if (cfg.selectedObjects?.identity) objectLabels.push('Identity');
  if (cfg.selectedObjects?.context) objectLabels.push('Context');
  if (cfg.selectedObjects?.usersGroupsMembers) objectLabels.push('Users & Groups');
  if (cfg.selectedObjects?.identityGovernance) objectLabels.push('Governance');
  if (cfg.selectedObjects?.appsAppRoles) objectLabels.push('Apps');
  if (cfg.selectedObjects?.directoryRoles) objectLabels.push('Dir Roles');

  const isRunning = runningJob && ['queued', 'running'].includes(runningJob.status);

  // Build schedule list (supports both `schedules` array and legacy `schedule` single)
  const scheduleList = cfg.schedules?.length ? cfg.schedules : (cfg.schedule ? [cfg.schedule] : []);
  const formatSched = (s) => {
    let label = s.frequency;
    if (s.frequency !== 'hourly') {
      label += ` at ${String(s.hour ?? 0).padStart(2,'0')}:${String(s.minute ?? 0).padStart(2,'0')} UTC`;
    } else {
      label += ` :${String(s.minute ?? 0).padStart(2,'0')}`;
    }
    if (s.frequency === 'weekly') {
      label += ` on ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][s.day ?? 0]}`;
    }
    return label;
  };

  return (
    <div className="p-4 bg-white border rounded-lg">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="font-semibold text-gray-900">{config.displayName}</h4>
          <span className="text-xs text-gray-500">{config.crawlerType}</span>
        </div>
        <div className="flex gap-1">
          {isRunning ? (
            <button
              onClick={() => onForceStop(runningJob.id)}
              className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
            >
              Force Stop
            </button>
          ) : (
            <button
              onClick={() => onRunNow(config.id)}
              className="px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
            >
              Run Now
            </button>
          )}
          <button onClick={() => onEdit(config)}
            className="px-3 py-1 text-xs bg-gray-100 rounded hover:bg-gray-200">
            Configure
          </button>
          <button onClick={() => onRemove(config.id)}
            className="px-3 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200">
            Remove
          </button>
        </div>
      </div>

      {config.crawlerType === 'entra-id' && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-3">
          <div><span className="text-gray-500">Tenant ID:</span> <span className="font-mono text-xs">{cfg.tenantId || '—'}</span></div>
          <div><span className="text-gray-500">Client ID:</span> <span className="font-mono text-xs">{cfg.clientId || '—'}</span></div>
          <div><span className="text-gray-500">Secret:</span> <span className="text-gray-400">{SECRET_MASK}</span></div>
          <div>
            <span className="text-gray-500">Objects:</span>{' '}
            {objectLabels.length > 0
              ? objectLabels.map(l => <span key={l} className="inline-block mr-1 px-1.5 py-0.5 bg-indigo-50 text-indigo-700 text-xs rounded">{l}</span>)
              : <span className="text-gray-400 text-xs">none</span>
            }
          </div>
        </div>
      )}

      {config.crawlerType === 'csv' && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-3">
          <div><span className="text-gray-500">System:</span> <span className="font-medium">{cfg.systemName || '—'}</span></div>
          <div><span className="text-gray-500">Type:</span> <span className="font-mono text-xs">{cfg.systemType || '—'}</span></div>
          <div><span className="text-gray-500">Delimiter:</span> <code className="text-xs">{cfg.delimiter === '\t' ? '\\t' : (cfg.delimiter || ';')}</code></div>
        </div>
      )}

      {/* Schedules */}
      {scheduleList.length > 0 && (
        <div className="text-xs text-gray-500 mt-2 space-y-1">
          {scheduleList.map((s, i) => (
            <div key={i}>
              <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded">
                Schedule: {formatSched(s)}
              </span>
            </div>
          ))}
        </div>
      )}
      {/* Identity filter badge */}
      {cfg.identityFilter?.attribute && (
        <div className="text-xs text-gray-500 mt-1">
          <span className="px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded">
            Identity filter: {cfg.identityFilter.attribute} {cfg.identityFilter.condition}
            {cfg.identityFilter.value && ` "${cfg.identityFilter.value}"`}
            {cfg.identityFilter.values?.length > 0 && ` ${JSON.stringify(cfg.identityFilter.values)}`}
          </span>
        </div>
      )}
      {/* Custom attribute counts */}
      {(cfg.customUserAttributes?.length > 0 || cfg.customGroupAttributes?.length > 0 || cfg.identityAttributes?.length > 0) && (
        <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-1">
          {cfg.identityAttributes?.length > 0 && (
            <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded">
              +{cfg.identityAttributes.length} identity attr{cfg.identityAttributes.length > 1 ? 's' : ''}
            </span>
          )}
          {cfg.customUserAttributes?.length > 0 && (
            <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded">
              +{cfg.customUserAttributes.length} user attr{cfg.customUserAttributes.length > 1 ? 's' : ''}
            </span>
          )}
          {cfg.customGroupAttributes?.length > 0 && (
            <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded">
              +{cfg.customGroupAttributes.length} group attr{cfg.customGroupAttributes.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}
      {config.lastRunAt && (
        <div className="text-xs text-gray-500 mt-2">
          Last run: {new Date(config.lastRunAt).toLocaleString()}
          {config.lastRunStatus && (
            <span className={`ml-2 px-1.5 py-0.5 rounded-full ${
              config.lastRunStatus === 'completed' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
            }`}>{config.lastRunStatus}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Job Progress Card ────────────────────────────────────────────────────────
function JobProgress({ job, onNavigateToMatrix, onDismiss }) {
  // Tick every second so the "last update Xs ago" line stays accurate even when
  // the backend hasn't pushed a new poll yet. Cheap, just a setInterval that bumps
  // a counter.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!job || ['completed','failed','cancelled'].includes(job.status)) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [job?.status]);

  if (!job) return null;
  const progress = job.progress ? (typeof job.progress === 'string' ? JSON.parse(job.progress) : job.progress) : {};
  const pct = progress.pct || 0;
  const step = progress.step || 'Waiting...';
  const detail = progress.detail || '';
  const updatedAt = progress.updatedAt ? new Date(progress.updatedAt) : null;
  const secondsSince = updatedAt ? Math.max(0, Math.round((Date.now() - updatedAt.getTime()) / 1000)) : null;
  // Re-read tick to silence the "unused" lint warning — the interval is what we want
  void tick;

  if (job.status === 'completed') {
    return (
      <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
        <div className="flex items-center justify-between">
          <div>
            <span className="font-semibold text-green-800">Data loaded successfully!</span>
            <p className="text-sm text-green-600 mt-1">Your identity data is ready to explore.</p>
          </div>
          <div className="flex gap-2">
            {onNavigateToMatrix && (
              <button onClick={onNavigateToMatrix} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700">Open Matrix</button>
            )}
            {onDismiss && <button onClick={onDismiss} className="text-green-600 hover:text-green-800 text-sm">Dismiss</button>}
          </div>
        </div>
      </div>
    );
  }
  if (job.status === 'failed') {
    return (
      <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
        <div className="flex items-center justify-between">
          <div>
            <span className="font-semibold text-red-800">Job failed</span>
            <p className="text-sm text-red-600 mt-1">{job.errorMessage || 'Unknown error'}</p>
          </div>
          {onDismiss && <button onClick={onDismiss} className="text-red-500 hover:text-red-700 text-sm">Dismiss</button>}
        </div>
      </div>
    );
  }
  // "Stale" once we've gone >60s without a fresh update — useful indicator that
  // something might be hung (or that the crawler is in an unreported tight loop).
  const staleness = secondsSince == null ? null
    : secondsSince < 10 ? 'fresh'
    : secondsSince < 60 ? 'normal'
    : 'stale';
  const stalenessColor = staleness === 'stale' ? 'text-amber-600' : 'text-blue-500';

  return (
    <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold text-blue-800">{job.status === 'queued' ? 'Waiting for worker...' : step}</span>
        <span className="text-sm text-blue-600">{pct}%</span>
      </div>
      <div className="w-full bg-blue-200 rounded-full h-2.5">
        <div className="bg-blue-600 h-2.5 rounded-full transition-all duration-500" style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      {(detail || secondsSince != null) && (
        <div className="flex items-center justify-between mt-2 text-xs">
          <span className="text-blue-700 truncate font-mono">{detail || ''}</span>
          {secondsSince != null && (
            <span className={`ml-2 flex-shrink-0 ${stalenessColor}`} title={updatedAt?.toLocaleString()}>
              {secondsSince === 0 ? 'just now' : `${secondsSince}s ago`}
              {staleness === 'stale' && ' · no updates'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Recent Jobs Table ────────────────────────────────────────────────────────
function RecentJobs({ jobs, onForceStop }) {
  if (!jobs || jobs.length === 0) return null;
  const statusColors = {
    queued: 'bg-yellow-100 text-yellow-800',
    running: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-800',
  };
  return (
    <div className="mb-6">
      <h3 className="text-lg font-semibold mb-3">Recent Jobs</h3>
      <div className="bg-white rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-3 font-medium">Type</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="text-left p-3 font-medium">Created</th>
              <th className="text-left p-3 font-medium">Duration</th>
              <th className="text-left p-3 font-medium">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {jobs.map(j => {
              const duration = j.startedAt && j.completedAt
                ? formatDurationHMS(Math.round((new Date(j.completedAt) - new Date(j.startedAt)) / 1000))
                : j.startedAt ? 'running...' : '—';
              return (
                <tr key={j.id}>
                  <td className="p-3 font-medium">{j.jobType}</td>
                  <td className="p-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[j.status] || ''}`}>{j.status}</span></td>
                  <td className="p-3 text-gray-500">{new Date(j.createdAt).toLocaleString()}</td>
                  <td className="p-3 text-gray-500">{duration}</td>
                  <td className="p-3 text-red-500 text-xs truncate max-w-64">
                    {j.status === 'running' || j.status === 'queued' ? (
                      <button onClick={() => onForceStop?.(j.id)} className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200">Force Stop</button>
                    ) : (j.errorMessage || '—')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── External Crawlers Table (API key crawlers) ──────────────────────────────
function ExternalCrawlers({ crawlers, onToggle, onResetKey, onRemove, newKey, onDismissKey, onCopy, expandedAudit, auditData, onToggleAudit }) {
  const visible = crawlers.filter(c => c.displayName !== 'Built-in Worker');
  if (visible.length === 0) return null;

  const formatDate = (d) => d ? new Date(d).toLocaleString() : '—';

  return (
    <div className="mb-6">
      <h3 className="text-lg font-semibold mb-3">External Crawlers</h3>

      {newKey && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-green-800">API Key Generated</span>
            <button onClick={onDismissKey} className="text-green-600 hover:text-green-800 text-sm">Dismiss</button>
          </div>
          <p className="text-sm text-green-700 mb-2">Store this key securely. It will not be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 p-2 bg-white border rounded font-mono text-sm break-all">{newKey}</code>
            <button onClick={() => onCopy(newKey)} className="px-3 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700">Copy</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-3 font-medium">Name</th>
              <th className="text-left p-3 font-medium">Key Prefix</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="text-left p-3 font-medium">Last Used</th>
              <th className="text-right p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {visible.map(c => (
              <tr key={c.id}>
                <td className="p-3">
                  <div className="font-medium">{c.displayName}</div>
                  {c.description && <div className="text-xs text-gray-500">{c.description}</div>}
                </td>
                <td className="p-3 font-mono text-xs">{c.apiKeyPrefix}...</td>
                <td className="p-3">
                  <button onClick={() => onToggle(c)}
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${c.enabled ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                    {c.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </td>
                <td className="p-3 text-gray-500">{formatDate(c.lastUsedAt)}</td>
                <td className="p-3 text-right">
                  <div className="flex gap-1 justify-end">
                    <button onClick={() => onToggleAudit(c.id)} className="px-2 py-1 text-xs bg-gray-100 rounded hover:bg-gray-200">
                      {expandedAudit === c.id ? 'Hide' : 'Log'}
                    </button>
                    <button onClick={() => onResetKey(c)} className="px-2 py-1 text-xs bg-amber-100 text-amber-800 rounded hover:bg-amber-200">Reset Key</button>
                    <button onClick={() => onRemove(c)} className="px-2 py-1 text-xs bg-red-100 text-red-800 rounded hover:bg-red-200">Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Getting Started Card ─────────────────────────────────────────────────────
function GettingStarted({ onAddCrawler }) {
  return (
    <div className="mb-8 p-6 bg-gradient-to-br from-emerald-50 to-teal-50 border border-emerald-200 rounded-xl text-center">
      <h2 className="text-xl font-bold text-emerald-900 mb-2">Welcome to Identity Atlas</h2>
      <p className="text-emerald-700 mb-4">No identity data loaded yet. Add a crawler to get started.</p>
      <button onClick={onAddCrawler} className="px-6 py-3 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium">
        Add Crawler
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CSV Crawler Wizard
// ═══════════════════════════════════════════════════════════════════════════════

// Expected CSV files. Must stay in sync with CSV_FILE_SLOTS in csvUploads.js and
// the file names that Start-CSVCrawler.ps1 reads.
// Identity Atlas canonical CSV schema. Must stay in sync with CSV_FILE_SLOTS in
// csvUploads.js and the schema templates in tools/csv-templates/schema/.
const CSV_SLOTS = [
  { key: 'systems',              file: 'Systems.csv',              label: 'Systems',                required: false, hint: 'Optional. Columns: ExternalId, DisplayName, SystemType, Description' },
  { key: 'contexts',             file: 'Contexts.csv',             label: 'Contexts (Org Units)',   required: false, hint: 'Optional. Columns: ExternalId, DisplayName, ContextType, Description, ParentExternalId, SystemName' },
  { key: 'resources',            file: 'Resources.csv',            label: 'Resources',              required: true,  hint: 'Required. Columns: ExternalId, DisplayName, ResourceType, Description, SystemName, Enabled' },
  { key: 'resourceRelationships',file: 'ResourceRelationships.csv',label: 'Resource Relationships', required: false, hint: 'Optional. Columns: ParentExternalId, ChildExternalId, RelationshipType, SystemName' },
  { key: 'users',                file: 'Users.csv',                label: 'Users',                  required: true,  hint: 'Required. Columns: ExternalId, DisplayName, Email, PrincipalType, JobTitle, Department, SystemName, Enabled' },
  { key: 'assignments',          file: 'Assignments.csv',          label: 'Assignments',            required: true,  hint: 'Required. Columns: ResourceExternalId, UserExternalId, AssignmentType, SystemName' },
  { key: 'identities',           file: 'Identities.csv',           label: 'Identities',             required: false, hint: 'Optional. Columns: ExternalId, DisplayName, Email, EmployeeId, Department, JobTitle' },
  { key: 'identityMembers',      file: 'IdentityMembers.csv',      label: 'Identity Members',       required: false, hint: 'Optional. Columns: IdentityExternalId, UserExternalId, AccountType' },
  { key: 'certifications',       file: 'Certifications.csv',       label: 'Certifications',         required: false, hint: 'Optional. Columns: ExternalId, ResourceExternalId, UserDisplayName, Decision, ReviewerDisplayName, ReviewedDateTime' },
];

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B','KB','MB','GB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// Match an uploaded filename against the expected slots. Case-insensitive,
// also tolerates "users.csv", "USERS.CSV", and minor naming variants like
// "Org_Units.csv" or "OrgUnits.csv". Returns the slot key or null.
function matchSlot(filename) {
  const lower = filename.toLowerCase().replace(/[\s_-]+/g, '');
  for (const s of CSV_SLOTS) {
    const target = s.file.toLowerCase().replace(/[\s_-]+/g, '');
    if (lower === target) return s.key;
    // Check aliases (e.g. "System.csv" → systems slot)
    for (const alias of (s.aliases || [])) {
      if (lower === alias.toLowerCase().replace(/[\s_-]+/g, '')) return s.key;
    }
  }
  // Looser fallback: contains the stem
  for (const s of CSV_SLOTS) {
    const stem = s.file.toLowerCase().replace('.csv', '').replace(/[\s_-]+/g, '');
    if (lower.includes(stem)) return s.key;
  }
  return null;
}

function CsvWizard({ onComplete, onCancel, initialConfig, isEdit, authFetch }) {
  // Steps: 1=info, 2=files, 3=review
  const [step, setStep] = useState(1);
  const [displayName, setDisplayName] = useState(initialConfig?.displayName || 'CSV Import');
  const [systemType, setSystemType] = useState(initialConfig?.systemType || 'CSV');
  const [systemName, setSystemName] = useState(initialConfig?.systemName || 'CSV Import');
  const [delimiter, setDelimiter] = useState(initialConfig?.delimiter || ';');

  // Files staged in the browser before upload (only on create)
  // and files already on the server (when editing).
  const [stagedFiles, setStagedFiles] = useState([]);    // [{ file: File, slot: string|null }]
  const [serverFiles, setServerFiles] = useState([]);    // [{ name, sizeBytes, modifiedAt }]
  const [savedConfigId, setSavedConfigId] = useState(initialConfig?.id || null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  // Load existing files for edit mode
  useEffect(() => {
    if (!savedConfigId) return;
    (async () => {
      try {
        const r = await authFetch(`/api/admin/crawler-configs/${savedConfigId}/csv-files`);
        if (r.ok) {
          const j = await r.json();
          setServerFiles(j.files || []);
        }
      } catch { /* ignore */ }
    })();
  }, [savedConfigId, authFetch]);

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    // Filter to .csv only
    const csv = files.filter(f => /\.csv$/i.test(f.name));
    const mapped = csv.map(file => ({ file, slot: matchSlot(file.name) }));
    setStagedFiles(prev => {
      // Merge: replace files with same name, keep others
      const byName = new Map(prev.map(s => [s.file.name, s]));
      for (const m of mapped) byName.set(m.file.name, m);
      return Array.from(byName.values());
    });
    e.target.value = ''; // allow re-selecting the same files
  };

  const removeStaged = (name) => setStagedFiles(prev => prev.filter(s => s.file.name !== name));
  const setStagedSlot = (name, slot) => setStagedFiles(prev => prev.map(s => s.file.name === name ? { ...s, slot } : s));

  const removeServerFile = async (name) => {
    if (!savedConfigId) return;
    if (!confirm(`Delete ${name} from the server?`)) return;
    try {
      await authFetch(`/api/admin/crawler-configs/${savedConfigId}/csv-files/${encodeURIComponent(name)}`, { method: 'DELETE' });
      setServerFiles(prev => prev.filter(f => f.name !== name));
    } catch (err) { setError(err.message); }
  };

  // Slot coverage check — used to enable/disable Save
  const allFiles = [
    ...serverFiles.map(f => ({ name: f.name, slot: matchSlot(f.name), source: 'server' })),
    ...stagedFiles.map(s => ({ name: s.file.name, slot: s.slot, source: 'staged' })),
  ];
  const filledSlots = new Set(allFiles.map(f => f.slot).filter(Boolean));
  const requiredSlots = CSV_SLOTS.filter(s => s.required);
  const missingRequired = requiredSlots.filter(s => !filledSlots.has(s.key));
  const canSave = !uploading && !saving && missingRequired.length === 0 && allFiles.length > 0;

  // Step 1 → 2 validation
  const canProceedFromInfo = displayName.trim() && systemName.trim() && systemType.trim() && delimiter;

  // Save handler — creates the config if needed, then uploads files
  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // 1. Create or update the config row
      const configPayload = { systemName, systemType, delimiter };
      let configId = savedConfigId;
      if (!configId) {
        const r = await authFetch('/api/admin/crawler-configs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ crawlerType: 'csv', displayName, config: configPayload }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || `HTTP ${r.status}`);
        }
        const created = await r.json();
        configId = created.id;
        setSavedConfigId(configId);
      } else {
        const r = await authFetch(`/api/admin/crawler-configs/${configId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName, config: configPayload }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || `HTTP ${r.status}`);
        }
      }

      // 2. Upload any staged files
      if (stagedFiles.length > 0) {
        setUploading(true);
        const fd = new FormData();
        for (const s of stagedFiles) fd.append('files', s.file, s.file.name);
        const r = await authFetch(`/api/admin/crawler-configs/${configId}/csv-files`, {
          method: 'POST',
          body: fd,
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || `HTTP ${r.status}`);
        }
        setStagedFiles([]);
      }

      onComplete();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
      setUploading(false);
    }
  };

  return (
    <div className="mb-6 p-5 bg-white border rounded-lg">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">{isEdit ? 'Edit CSV Crawler' : 'Add CSV Crawler'} — Step {step} of 3</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-700 text-sm">Cancel</button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── Step 1: System info ──────────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Display name</label>
            <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
              placeholder="e.g. Omada Production"
              className="w-full px-3 py-2 border rounded text-sm" />
            <p className="text-xs text-gray-500 mt-1">Shown on the configured crawlers card.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">System name</label>
              <input type="text" value={systemName} onChange={e => setSystemName(e.target.value)}
                className="w-full px-3 py-2 border rounded text-sm" />
              <p className="text-xs text-gray-500 mt-1">Recorded in <code>dbo.Systems.displayName</code>.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">System type</label>
              <input type="text" value={systemType} onChange={e => setSystemType(e.target.value)}
                placeholder="Omada / SailPoint / Custom"
                className="w-full px-3 py-2 border rounded text-sm" />
              <p className="text-xs text-gray-500 mt-1">Used for grouping in the UI.</p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">CSV delimiter</label>
            <select value={delimiter} onChange={e => setDelimiter(e.target.value)}
              className="px-3 py-2 border rounded text-sm">
              <option value=";">Semicolon (;)</option>
              <option value=",">Comma (,)</option>
              <option value="\t">Tab</option>
              <option value="|">Pipe (|)</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setStep(2)} disabled={!canProceedFromInfo}
              className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50">
              Next: Upload files
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: File upload ──────────────────────────────────────────── */}
      {step === 2 && (
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm text-blue-800">
            <div>Upload CSV files in the <strong>Identity Atlas schema</strong>. Files are auto-mapped by name.</div>
            <div className="mt-1">
              <a href="/api/admin/csv-schema" download className="text-indigo-700 underline hover:text-indigo-900">
                Download schema templates
              </a>
              <span className="text-blue-600 ml-2">— empty CSVs with the expected column headers. Use a transform script to convert your source data to this format.</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <label className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 cursor-pointer">
              Select folder
              <input type="file" multiple webkitdirectory="" directory="" onChange={handleFileSelect} className="hidden" />
            </label>
            <label className="px-4 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 cursor-pointer">
              Select files
              <input type="file" multiple accept=".csv" onChange={handleFileSelect} className="hidden" />
            </label>
          </div>

          {/* Staged files (not yet uploaded) */}
          {stagedFiles.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">Staged files ({stagedFiles.length})</h4>
              <div className="border rounded divide-y">
                {stagedFiles.map(s => (
                  <div key={s.file.name} className="flex items-center justify-between p-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono truncate">{s.file.name}</div>
                      <div className="text-xs text-gray-500">{fmtBytes(s.file.size)}</div>
                    </div>
                    <select value={s.slot || ''} onChange={e => setStagedSlot(s.file.name, e.target.value || null)}
                      className="ml-2 text-xs border rounded px-1 py-0.5">
                      <option value="">— Ignore —</option>
                      {CSV_SLOTS.map(slot => (
                        <option key={slot.key} value={slot.key}>{slot.label}{slot.required ? ' *' : ''}</option>
                      ))}
                    </select>
                    <button onClick={() => removeStaged(s.file.name)}
                      className="ml-2 text-red-500 hover:text-red-700 text-xs">Remove</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Files already on the server (edit mode) */}
          {serverFiles.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">Already uploaded ({serverFiles.length})</h4>
              <div className="border rounded divide-y">
                {serverFiles.map(f => {
                  const slot = matchSlot(f.name);
                  const slotLabel = CSV_SLOTS.find(s => s.key === slot)?.label || 'Unrecognized';
                  return (
                    <div key={f.name} className="flex items-center justify-between p-2 text-sm">
                      <div className="flex-1 min-w-0">
                        <div className="font-mono truncate">{f.name}</div>
                        <div className="text-xs text-gray-500">{fmtBytes(f.sizeBytes)} · {new Date(f.modifiedAt).toLocaleString()}</div>
                      </div>
                      <span className={`ml-2 px-2 py-0.5 rounded text-xs ${slot ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{slotLabel}</span>
                      <button onClick={() => removeServerFile(f.name)}
                        className="ml-2 text-red-500 hover:text-red-700 text-xs">Delete</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Required-slot coverage */}
          <div className="bg-gray-50 border rounded p-3">
            <div className="text-xs font-semibold text-gray-700 mb-2">Required object types</div>
            <div className="flex flex-wrap gap-2">
              {CSV_SLOTS.map(slot => {
                const filled = filledSlots.has(slot.key);
                return (
                  <span key={slot.key} className={`px-2 py-1 rounded text-xs ${
                    filled ? 'bg-green-100 text-green-800' : (slot.required ? 'bg-red-100 text-red-700' : 'bg-gray-200 text-gray-600')
                  }`} title={slot.hint || ''}>
                    {filled ? '✓ ' : (slot.required ? '✗ ' : '○ ')}{slot.label}{slot.required ? ' *' : ''}
                  </span>
                );
              })}
            </div>
            {missingRequired.length > 0 && (
              <div className="text-xs text-red-600 mt-2">
                Missing required: {missingRequired.map(s => s.file).join(', ')}
              </div>
            )}
          </div>

          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className="px-4 py-2 bg-gray-100 rounded text-sm">Back</button>
            <button onClick={() => setStep(3)} disabled={missingRequired.length > 0 || allFiles.length === 0}
              className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50">
              Next: Review
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Review ──────────────────────────────────────────────── */}
      {step === 3 && (
        <div className="space-y-4">
          <div className="bg-gray-50 border rounded p-4 space-y-2 text-sm">
            <div><span className="text-gray-500">Display name:</span> <span className="font-medium">{displayName}</span></div>
            <div><span className="text-gray-500">System:</span> {systemName} ({systemType})</div>
            <div><span className="text-gray-500">Delimiter:</span> <code>{delimiter === '\t' ? '\\t' : delimiter}</code></div>
            <div><span className="text-gray-500">Files:</span> {allFiles.length} total ({stagedFiles.length} new, {serverFiles.length} existing)</div>
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(2)} className="px-4 py-2 bg-gray-100 rounded text-sm">Back</button>
            <button onClick={handleSave} disabled={!canSave}
              className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50">
              {uploading ? 'Uploading...' : saving ? 'Saving...' : (isEdit ? 'Save changes' : 'Create crawler')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main CrawlersPage
// ═══════════════════════════════════════════════════════════════════════════════

export default function CrawlersPage({ onNavigate }) {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Data
  const [crawlers, setCrawlers] = useState([]);
  const [configs, setConfigs] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [status, setStatus] = useState(null);
  const [activeJob, setActiveJob] = useState(null);
  const pollRef = useRef(null);

  // Wizard state — 'select' (type picker), 'entra-wizard' (full wizard)
  const [wizardStep, setWizardStep] = useState(null);
  // When editing an existing config, holds its full data + id; null otherwise
  const [editingConfig, setEditingConfig] = useState(null);

  // External crawler state
  const [newKey, setNewKey] = useState(null);
  const [expandedAudit, setExpandedAudit] = useState(null);
  const [auditData, setAuditData] = useState({ data: [], total: 0 });

  // ── Fetchers ──────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try { const r = await authFetch('/api/admin/status'); if (r.ok) setStatus(await r.json()); } catch {}
  }, [authFetch]);

  const fetchConfigs = useCallback(async () => {
    try { const r = await authFetch('/api/admin/crawler-configs'); if (r.ok) setConfigs(await r.json()); } catch {}
  }, [authFetch]);

  const fetchCrawlers = useCallback(async () => {
    try {
      const r = await authFetch('/api/admin/crawlers');
      if (r.ok) setCrawlers(await r.json());
    } catch {}
  }, [authFetch]);

  const fetchJobs = useCallback(async () => {
    try {
      const r = await authFetch('/api/admin/crawler-jobs?limit=10');
      if (r.ok) {
        const data = await r.json();
        setJobs(Array.isArray(data) ? data : []);
        const active = data.find(j => j.status === 'queued' || j.status === 'running');
        if (active) {
          setActiveJob(active);
        } else if (activeJob && ['queued', 'running'].includes(activeJob.status)) {
          const finished = data.find(j => j.id === activeJob.id);
          if (finished) setActiveJob(finished);
          fetchStatus();
          fetchConfigs();
        }
      }
    } catch {}
  }, [authFetch, activeJob, fetchStatus, fetchConfigs]);

  useEffect(() => {
    Promise.all([fetchCrawlers(), fetchConfigs(), fetchStatus(), fetchJobs()])
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (activeJob && ['queued', 'running'].includes(activeJob.status)) {
      pollRef.current = setInterval(fetchJobs, 3000);
      return () => clearInterval(pollRef.current);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
    }
  }, [activeJob, fetchJobs]);

  // ── Wizard actions ────────────────────────────────────────────

  const handleSelectType = (type) => {
    if (type === 'demo') {
      submitJob('demo');
      setWizardStep(null);
    } else if (type === 'entra-id') {
      setEditingConfig(null);
      setWizardStep('entra-wizard');
    } else if (type === 'csv') {
      setEditingConfig(null);
      setWizardStep('csv-wizard');
    }
  };

  // Wizard helper: validate credentials
  const validateCredentials = async (creds) => {
    const r = await authFetch('/api/admin/validate-graph-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    return await r.json();
  };

  // Wizard helper: discover Graph attributes
  const discoverAttributes = async ({ tenantId, clientId, clientSecret, configId, type }) => {
    const body = { type };
    if (clientSecret) Object.assign(body, { tenantId, clientId, clientSecret });
    else if (configId) body.configId = configId;
    const r = await authFetch('/api/admin/discover-graph-attributes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    return await r.json();
  };

  // Wizard completion: create or update a CrawlerConfig
  const handleWizardComplete = async (wizardConfig) => {
    try {
      const { displayName, credentials, selectedObjects, identityAttributes,
              customUserAttributes, customGroupAttributes, identityFilter, schedules } = wizardConfig;

      const configPayload = {
        tenantId: credentials.tenantId,
        clientId: credentials.clientId,
        // Empty secret in edit mode means "keep existing"
        clientSecret: credentials.clientSecret || undefined,
        selectedObjects,
      };
      if (identityAttributes?.length) configPayload.identityAttributes = identityAttributes;
      if (customUserAttributes?.length) configPayload.customUserAttributes = customUserAttributes;
      if (customGroupAttributes?.length) configPayload.customGroupAttributes = customGroupAttributes;
      if (identityFilter?.attribute) configPayload.identityFilter = identityFilter;
      if (schedules?.length) configPayload.schedules = schedules;

      // Strip undefined clientSecret to avoid wiping it server-side
      if (configPayload.clientSecret === undefined) delete configPayload.clientSecret;

      let r;
      if (editingConfig?.id) {
        r = await authFetch(`/api/admin/crawler-configs/${editingConfig.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName, config: configPayload }),
        });
      } else {
        r = await authFetch('/api/admin/crawler-configs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            crawlerType: 'entra-id',
            displayName,
            config: configPayload,
          }),
        });
      }
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      setWizardStep(null);
      setEditingConfig(null);
      fetchConfigs();
    } catch (err) {
      setError(err.message);
      throw err; // re-throw so wizard can stop the saving spinner
    }
  };

  // Open the wizard in edit mode for an existing config
  const handleEditConfig = (config) => {
    // The config from the API has secrets masked — wizard handles this
    setEditingConfig({
      id: config.id,
      displayName: config.displayName,
      ...(config.config || {}),
    });
    setWizardStep(config.crawlerType === 'csv' ? 'csv-wizard' : 'entra-wizard');
  };

  // ── Job actions ───────────────────────────────────────────────

  const submitJob = async (jobType, config = null, configId = null) => {
    try {
      const body = { jobType };
      if (config) body.config = config;
      if (configId) body.configId = configId;
      const r = await authFetch('/api/admin/crawler-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error || `HTTP ${r.status}`); }
      const job = await r.json();
      setActiveJob(job);
      fetchJobs();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRunNow = (configId) => {
    const cfg = configs.find(c => c.id === configId);
    if (cfg) submitJob(cfg.crawlerType, null, configId);
  };

  const handleForceStop = async (jobId) => {
    if (!confirm('Force-stop this running job? Any partially imported data will remain.')) return;
    try {
      await authFetch(`/api/admin/crawler-jobs/${jobId}/force-stop`, { method: 'POST' });
      fetchJobs();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemoveConfig = async (configId) => {
    if (!confirm('Remove this crawler configuration?')) return;
    try {
      await authFetch(`/api/admin/crawler-configs/${configId}`, { method: 'DELETE' });
      fetchConfigs();
    } catch (err) {
      setError(err.message);
    }
  };

  // ── External crawler actions ──────────────────────────────────

  const handleToggleEnabled = async (c) => {
    try {
      await authFetch(`/api/admin/crawlers/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !c.enabled }) });
      fetchCrawlers();
    } catch (err) { setError(err.message); }
  };

  const handleResetKey = async (c) => {
    if (!confirm(`Reset API key for "${c.displayName}"?`)) return;
    try {
      const r = await authFetch(`/api/admin/crawlers/${c.id}/reset`, { method: 'POST' });
      if (r.ok) { const d = await r.json(); setNewKey(d.apiKey); }
    } catch (err) { setError(err.message); }
  };

  const handleRemoveCrawler = async (c) => {
    if (!confirm(`Remove crawler "${c.displayName}"?`)) return;
    try {
      await authFetch(`/api/admin/crawlers/${c.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permanent: true }) });
      fetchCrawlers();
    } catch (err) { setError(err.message); }
  };

  const toggleAudit = async (id) => {
    if (expandedAudit === id) { setExpandedAudit(null); return; }
    try {
      const r = await authFetch(`/api/admin/crawlers/${id}/audit?limit=20`);
      if (r.ok) { setAuditData(await r.json()); setExpandedAudit(id); }
    } catch (err) { setError(err.message); }
  };

  // ── Render ────────────────────────────────────────────────────

  if (loading) return <div className="p-6 text-gray-500">Loading...</div>;

  const showGettingStarted = status && !status.hasData && configs.length === 0 && !wizardStep;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Crawlers</h1>
        {!wizardStep && (
          <button onClick={() => setWizardStep('select')}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium">
            Add Crawler
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between">
          <span className="text-red-700 text-sm">{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700 text-sm">Dismiss</button>
        </div>
      )}

      {/* Getting started */}
      {showGettingStarted && <GettingStarted onAddCrawler={() => setWizardStep('select')} />}

      {/* Active job progress */}
      {activeJob && ['queued', 'running', 'completed', 'failed'].includes(activeJob.status) && (
        <JobProgress job={activeJob} onNavigateToMatrix={() => onNavigate?.('matrix')} onDismiss={() => setActiveJob(null)} />
      )}

      {/* Wizard steps */}
      {wizardStep === 'select' && (
        <SelectType onSelect={handleSelectType} onCancel={() => setWizardStep(null)} />
      )}
      {wizardStep === 'entra-wizard' && (
        <EntraIdWizard
          onComplete={handleWizardComplete}
          onCancel={() => { setWizardStep(null); setEditingConfig(null); }}
          validateFn={validateCredentials}
          discoverFn={discoverAttributes}
          initialConfig={editingConfig}
          isEdit={!!editingConfig}
        />
      )}
      {wizardStep === 'csv-wizard' && (
        <CsvWizard
          onComplete={() => {
            setWizardStep(null);
            setEditingConfig(null);
            fetchConfigs();
          }}
          onCancel={() => { setWizardStep(null); setEditingConfig(null); }}
          initialConfig={editingConfig}
          isEdit={!!editingConfig}
          authFetch={authFetch}
        />
      )}

      {/* Configured crawlers */}
      {configs.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3">Configured Crawlers</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {configs.map(c => (
              <CrawlerConfigCard
                key={c.id}
                config={c}
                onRunNow={handleRunNow}
                onEdit={handleEditConfig}
                onRemove={handleRemoveConfig}
                onForceStop={handleForceStop}
                runningJob={activeJob?.jobType === c.crawlerType ? activeJob : null}
              />
            ))}
          </div>
        </div>
      )}

      {/* Recent jobs */}
      <RecentJobs jobs={jobs} onForceStop={handleForceStop} />

      {/* External crawlers (API key-based, excluding Built-in Worker) */}
      <ExternalCrawlers
        crawlers={crawlers}
        onToggle={handleToggleEnabled}
        onResetKey={handleResetKey}
        onRemove={handleRemoveCrawler}
        newKey={newKey}
        onDismissKey={() => setNewKey(null)}
        onCopy={(t) => navigator.clipboard.writeText(t)}
        expandedAudit={expandedAudit}
        auditData={auditData}
        onToggleAudit={toggleAudit}
      />
    </div>
  );
}
