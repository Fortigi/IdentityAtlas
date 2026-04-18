import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';

const PLUGIN_TYPES = [
  { value: 'bloodhound-ce', label: 'BloodHound CE', description: 'Attack path analysis via BloodHound Community Edition' },
  { value: 'http-api', label: 'Custom HTTP API', description: 'Any external scoring system with an HTTP endpoint' },
];

function StatusBadge({ status }) {
  const styles = {
    healthy:   'bg-emerald-100 text-emerald-800',
    unhealthy: 'bg-red-100 text-red-800',
    unknown:   'bg-gray-100 text-gray-600',
  };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || styles.unknown}`}>
      {status || 'unknown'}
    </span>
  );
}

// ─── Step indicator (same pattern as CrawlersPage) ───────────────────
function StepIndicator({ steps, step }) {
  return (
    <div className="flex items-center gap-2 mb-5 text-xs">
      {steps.map((s, i, arr) => (
        <div key={s.n} className="flex items-center gap-2">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center font-semibold ${
            s.n === step ? 'bg-indigo-600 text-white' :
            s.n < step ? 'bg-indigo-100 text-indigo-700' :
            'bg-gray-200 text-gray-500'
          }`}>{i + 1}</div>
          <span className={s.n === step ? 'font-medium text-gray-900' : 'text-gray-500'}>{s.label}</span>
          {i < arr.length - 1 && <span className="text-gray-300">&rarr;</span>}
        </div>
      ))}
    </div>
  );
}

const BH_STEPS = [
  { n: 1, label: 'Connect' },
  { n: 2, label: 'Authenticate' },
  { n: 3, label: 'Configure' },
  { n: 4, label: 'Export & Test' },
];

// ─── BloodHound CE setup wizard ──────────────────────────────────────
function BloodHoundWizard({ authFetch, onDone, onCancel }) {
  const [step, setStep] = useState(1);

  // Step 1 state
  const [endpointUrl, setEndpointUrl] = useState('http://bloodhound:8080');
  const [checking, setChecking] = useState(false);
  const [reachable, setReachable] = useState(null); // null | true | false
  const [checkError, setCheckError] = useState(null);

  // Step 2 state
  const [apiKey, setApiKey] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [verifyError, setVerifyError] = useState(null);
  const [pluginId, setPluginId] = useState(null);

  // Step 3 state
  const [dataMode, setDataMode] = useState('export');
  const [tenantId, setTenantId] = useState('');
  const [weight, setWeight] = useState(0.15);
  const [autoExport, setAutoExport] = useState(true);

  // Step 2 extra: auto-fetched BH initial password
  const [bhPassword, setBhPassword] = useState(null);
  const [bhPasswordLoading, setBhPasswordLoading] = useState(false);

  // Step 4 state
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState(null);
  const [exportError, setExportError] = useState(null);

  // Step 1: Check if BH is reachable via our API (proxy through the server)
  const handleCheck = async () => {
    setChecking(true);
    setCheckError(null);
    setReachable(null);
    try {
      // Create a temporary plugin to test connectivity, or just try the test endpoint
      const res = await authFetch('/api/risk-plugins/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginType: 'bloodhound-ce', endpointUrl }),
      });
      if (res.ok) {
        setReachable(true);
      } else {
        // Fallback: create the plugin and health-check it
        const createRes = await authFetch('/api/risk-plugins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pluginType: 'bloodhound-ce',
            displayName: 'BloodHound CE',
            endpointUrl,
            defaultWeight: 0.15,
          }),
        });
        if (!createRes.ok) throw new Error(`HTTP ${createRes.status}`);
        const plugin = await createRes.json();
        setPluginId(plugin.id);

        const healthRes = await authFetch(`/api/risk-plugins/${plugin.id}/health`, { method: 'POST' });
        const healthData = await healthRes.json();
        setReachable(healthData.healthStatus === 'healthy');
        if (healthData.healthStatus !== 'healthy') {
          setCheckError('BloodHound is not reachable at this URL. Make sure the container is running.');
        }
      }
    } catch (err) {
      setReachable(false);
      setCheckError(err.message);
    } finally {
      setChecking(false);
    }
  };

  // Step 2: Auto-setup — login to BH, create API token, configure plugin
  // Called automatically when entering step 2, or manually with a user-typed password
  const handleAutoSetup = async (manualPassword) => {
    setVerifying(true);
    setVerifyError(null);
    try {
      // 1. Auto-setup: login + create API token
      // Send password if user typed one; otherwise server tries auto-detected passwords
      const payload = { endpointUrl, username: 'admin' };
      if (manualPassword || apiKey) payload.password = manualPassword || apiKey;

      const setupRes = await authFetch('/api/risk-plugins/bloodhound/auto-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const setupData = await setupRes.json();
      if (!setupRes.ok || !setupData.success) {
        setVerifyError(setupData.detail || setupData.error || 'Auto-setup failed');
        setVerifying(false);
        return;
      }

      // 2. Create/update the plugin with the HMAC credentials
      const bhApiKey = `${setupData.tokenId}:${setupData.tokenKey}`;
      let id = pluginId;
      if (!id) {
        const res = await authFetch('/api/risk-plugins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pluginType: 'bloodhound-ce',
            displayName: 'BloodHound CE',
            endpointUrl,
            apiKey: bhApiKey,
            defaultWeight: 0.15,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const plugin = await res.json();
        id = plugin.id;
        setPluginId(id);
      } else {
        await authFetch(`/api/risk-plugins/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: bhApiKey }),
        });
      }

      // 3. Health check
      await authFetch(`/api/risk-plugins/${id}/health`, { method: 'POST' });
      setVerified(true);
    } catch (err) {
      setVerifyError(err.message);
    } finally {
      setVerifying(false);
    }
  };

  // Step 2 (manual fallback): Save API key and verify
  const handleVerify = async () => {
    setVerifying(true);
    setVerifyError(null);
    try {
      let id = pluginId;
      if (!id) {
        // Create plugin if not yet created
        const res = await authFetch('/api/risk-plugins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pluginType: 'bloodhound-ce',
            displayName: 'BloodHound CE',
            endpointUrl,
            apiKey,
            defaultWeight: 0.15,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const plugin = await res.json();
        id = plugin.id;
        setPluginId(id);
      } else {
        // Update with API key
        await authFetch(`/api/risk-plugins/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey }),
        });
      }

      // Health check with the key
      const healthRes = await authFetch(`/api/risk-plugins/${id}/health`, { method: 'POST' });
      const healthData = await healthRes.json();
      if (healthData.healthStatus === 'healthy') {
        setVerified(true);
      } else {
        setVerifyError('Authentication failed. Check your API key and try again.');
      }
    } catch (err) {
      setVerifyError(err.message);
    } finally {
      setVerifying(false);
    }
  };

  // Step 3: Save configuration
  const handleSaveConfig = async () => {
    if (!pluginId) return;
    try {
      await authFetch(`/api/risk-plugins/${pluginId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultWeight: weight,
          config: { dataMode, tenantId: tenantId || undefined, autoExport },
        }),
      });
      // Enable the plugin
      await authFetch(`/api/risk-plugins/${pluginId}/toggle`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      setStep(4);
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  };

  // Step 4: Export data
  const handleExport = async () => {
    if (!pluginId) return;
    setExporting(true);
    setExportError(null);
    try {
      const res = await authFetch(`/api/risk-plugins/${pluginId}/export`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setExportResult(await res.json());
    } catch (err) {
      setExportError(err.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Set up BloodHound CE</h3>
        <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
      </div>

      <StepIndicator steps={BH_STEPS} step={step} />

      {/* ── Step 1: Connect ─────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="p-4 bg-blue-50 border border-blue-200 rounded text-sm text-blue-900">
            <p className="font-medium mb-2">Start BloodHound CE</p>
            <p className="text-xs mb-2">If BloodHound is not already running, start it with:</p>
            <pre className="bg-blue-100 p-2 rounded text-xs font-mono overflow-x-auto">
              docker compose -f docker-compose.yml -f docker-compose.bloodhound.yml --profile bloodhound up -d
            </pre>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">BloodHound Internal URL</label>
            <input value={endpointUrl} onChange={e => setEndpointUrl(e.target.value)}
              placeholder="http://bloodhound:8080"
              className="w-full p-2 border border-gray-200 rounded text-sm font-mono" />
            <p className="text-xs text-gray-500 mt-1">
              This is the server-to-server address used by Identity Atlas to communicate with BloodHound.
              The default <code className="bg-gray-100 px-1 rounded">http://bloodhound:8080</code> is
              correct when both run in the same docker-compose stack. If BloodHound runs on a separate
              host, enter that host's address here.
            </p>
          </div>

          {reachable === true && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-800 flex items-center gap-2">
              <span className="text-lg">&#10003;</span> BloodHound is reachable at <code className="bg-emerald-100 px-1 rounded">{endpointUrl}</code>
            </div>
          )}
          {reachable === false && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
              {checkError || 'BloodHound is not reachable. Make sure the container is running and the URL is correct.'}
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={handleCheck} disabled={checking || !endpointUrl}
              className="px-4 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50">
              {checking ? 'Checking...' : 'Check Connection'}
            </button>
            {reachable && (
              <button onClick={() => setStep(2)}
                className="px-4 py-2 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700">
                Next &rarr;
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Step 2: Authenticate ────────────────────────────── */}
      {step === 2 && (() => {
        // Auto-attempt connection when entering this step (no password needed —
        // the server tries the initial password from Docker logs automatically)
        if (!verified && !verifying && !verifyError) {
          handleAutoSetup();
        }
        return (
        <div className="space-y-4">
          {verifying && !verified && (
            <div className="p-4 bg-indigo-50 border border-indigo-200 rounded text-sm text-indigo-900 flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Connecting to BloodHound and creating API token...
            </div>
          )}

          {verified && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-800 flex items-center gap-2">
              <span className="text-lg">&#10003;</span> Connected! API token created and configured automatically.
            </div>
          )}

          {verifyError && (
            <>
              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
                Auto-connect could not log in automatically. Please enter the BloodHound admin password below.
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">BloodHound Admin Password</label>
                <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                  placeholder="Enter the BloodHound admin password"
                  className="w-full p-2 border border-gray-200 rounded text-sm font-mono" />
              </div>
            </>
          )}

          <div className="flex gap-2">
            <button onClick={() => { setStep(1); setVerifyError(null); setVerified(false); }}
              className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">
              &larr; Back
            </button>
            {verifyError && (
              <button onClick={() => { setVerifyError(null); handleAutoSetup(apiKey); }} disabled={verifying || !apiKey}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50">
                {verifying ? 'Connecting...' : 'Retry with Password'}
              </button>
            )}
            {verified && (
              <button onClick={() => setStep(3)}
                className="px-4 py-2 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700">
                Next &rarr;
              </button>
            )}
          </div>
        </div>
        );
      })()}

      {/* ── Step 3: Configure ───────────────────────────────── */}
      {step === 3 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Data Mode</label>
              <select value={dataMode} onChange={e => setDataMode(e.target.value)}
                className="w-full p-2 border border-gray-200 rounded text-sm">
                <option value="export">Export Identity Atlas data to BloodHound</option>
                <option value="existing">Query existing BloodHound data (SharpHound)</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                {dataMode === 'export'
                  ? 'Identity Atlas will push users, groups, and memberships to BloodHound before each scoring run.'
                  : 'BloodHound already has data (e.g. from SharpHound). Identity Atlas will only query for scores.'}
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Tenant ID (optional)</label>
              <input value={tenantId} onChange={e => setTenantId(e.target.value)}
                placeholder="Auto-detected from crawler config"
                className="w-full p-2 border border-gray-200 rounded text-sm font-mono" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">
              Score Weight: {Math.round(weight * 100)}% of final risk score
            </label>
            <input type="range" min="0.05" max="0.30" step="0.01"
              value={weight} onChange={e => setWeight(parseFloat(e.target.value))}
              className="w-full" />
            <p className="text-xs text-gray-500 mt-1">
              How much BloodHound attack path data influences the overall score. Other components scale down proportionally.
            </p>
          </div>

          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={autoExport}
              onChange={e => setAutoExport(e.target.checked)} />
            Automatically export data before each scoring run
          </label>

          <div className="flex gap-2">
            <button onClick={() => setStep(2)}
              className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">
              &larr; Back
            </button>
            <button onClick={handleSaveConfig}
              className="px-4 py-2 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700">
              Save &amp; Enable &rarr;
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4: Export & Test ────────────────────────────── */}
      {step === 4 && (
        <div className="space-y-4">
          <div className="p-4 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-800">
            <span className="text-lg">&#10003;</span>{' '}
            <span className="font-medium">BloodHound CE plugin is configured and enabled!</span>
          </div>

          {dataMode === 'export' && !exportResult && (
            <div>
              <p className="text-sm text-gray-700 mb-3">
                Export your Identity Atlas data to BloodHound so it can analyze attack paths.
              </p>
              {exportError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 mb-3">{exportError}</div>
              )}
              <button onClick={handleExport} disabled={exporting}
                className="px-4 py-2 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50">
                {exporting ? 'Exporting...' : 'Export Data to BloodHound'}
              </button>
            </div>
          )}

          {exportResult && (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded">
              <p className="text-sm font-medium text-gray-900 mb-2">Export Complete</p>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="p-3 bg-white rounded border">
                  <div className="text-2xl font-bold text-indigo-600">{exportResult.users || 0}</div>
                  <div className="text-xs text-gray-500">Users</div>
                </div>
                <div className="p-3 bg-white rounded border">
                  <div className="text-2xl font-bold text-indigo-600">{exportResult.groups || 0}</div>
                  <div className="text-xs text-gray-500">Groups</div>
                </div>
                <div className="p-3 bg-white rounded border">
                  <div className="text-2xl font-bold text-indigo-600">{exportResult.relationships || 0}</div>
                  <div className="text-xs text-gray-500">Memberships</div>
                </div>
              </div>
            </div>
          )}

          <div className="p-4 bg-blue-50 border border-blue-200 rounded text-sm text-blue-900">
            <p className="font-medium mb-1">What happens next?</p>
            <p className="text-xs">
              When you run a scoring job (Admin &rarr; Risk Scoring &rarr; Run), the engine will query
              BloodHound for attack path analysis and merge it into the risk scores as a{' '}
              <strong>{Math.round(weight * 100)}%</strong> weighted component.
            </p>
          </div>

          <button onClick={onDone}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700">
            Done
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Plugin type selector (shown before wizard/form) ─────────────────
function PluginTypeSelector({ onSelect, onCancel }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
      <h3 className="text-sm font-semibold">Add Plugin</h3>
      <p className="text-xs text-gray-500">Select the type of risk scoring plugin to configure:</p>
      <div className="grid grid-cols-2 gap-4">
        {PLUGIN_TYPES.map(t => (
          <button key={t.value} onClick={() => onSelect(t.value)}
            className="p-4 border border-gray-200 rounded-lg text-left hover:border-indigo-400 hover:bg-indigo-50 transition-colors">
            <div className="text-sm font-semibold text-gray-900">{t.label}</div>
            <p className="text-xs text-gray-500 mt-1">{t.description}</p>
          </button>
        ))}
      </div>
      <button onClick={onCancel} className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">
        Cancel
      </button>
    </div>
  );
}

function PluginForm({ plugin, onSave, onCancel }) {
  const [form, setForm] = useState({
    pluginType: plugin?.pluginType || 'bloodhound-ce',
    displayName: plugin?.displayName || '',
    description: plugin?.description || '',
    endpointUrl: plugin?.endpointUrl || '',
    apiKey: '',
    defaultWeight: plugin?.defaultWeight || 0.15,
    config: plugin?.config || {},
  });

  const update = (field, value) => setForm(f => ({ ...f, [field]: value }));
  const updateConfig = (field, value) => setForm(f => ({ ...f, config: { ...f.config, [field]: value } }));

  const typeInfo = PLUGIN_TYPES.find(t => t.value === form.pluginType);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
      <h3 className="text-sm font-semibold">{plugin ? 'Edit Plugin' : 'Add Plugin'}</h3>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium mb-1">Plugin Type</label>
          <select value={form.pluginType} onChange={e => update('pluginType', e.target.value)}
            disabled={!!plugin}
            className="w-full p-2 border border-gray-200 rounded text-sm disabled:bg-gray-50">
            {PLUGIN_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {typeInfo && <p className="text-xs text-gray-500 mt-1">{typeInfo.description}</p>}
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Display Name</label>
          <input value={form.displayName} onChange={e => update('displayName', e.target.value)}
            placeholder="e.g. BloodHound Production"
            className="w-full p-2 border border-gray-200 rounded text-sm" />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium mb-1">Description</label>
        <input value={form.description} onChange={e => update('description', e.target.value)}
          placeholder="Optional description"
          className="w-full p-2 border border-gray-200 rounded text-sm" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium mb-1">Endpoint URL</label>
          <input value={form.endpointUrl} onChange={e => update('endpointUrl', e.target.value)}
            placeholder={form.pluginType === 'bloodhound-ce' ? 'http://bloodhound:8080' : 'https://scoring.example.com'}
            className="w-full p-2 border border-gray-200 rounded text-sm font-mono" />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">API Key</label>
          <input type="password" value={form.apiKey} onChange={e => update('apiKey', e.target.value)}
            placeholder={plugin ? '(unchanged)' : 'Bearer token / API key'}
            className="w-full p-2 border border-gray-200 rounded text-sm font-mono" />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium mb-1">
          Weight: {Number(form.defaultWeight).toFixed(2)} ({Math.round(form.defaultWeight * 100)}% of final score)
        </label>
        <input type="range" min="0.01" max="0.40" step="0.01"
          value={form.defaultWeight}
          onChange={e => update('defaultWeight', parseFloat(e.target.value))}
          className="w-full" />
        <p className="text-xs text-gray-500 mt-1">
          When enabled, other score components scale down proportionally to make room.
        </p>
      </div>

      {/* BloodHound-specific config */}
      {form.pluginType === 'bloodhound-ce' && (
        <div className="p-3 bg-gray-50 rounded space-y-3">
          <h4 className="text-xs font-semibold text-gray-700">BloodHound Settings</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Data Mode</label>
              <select value={form.config.dataMode || 'export'}
                onChange={e => updateConfig('dataMode', e.target.value)}
                className="w-full p-2 border border-gray-200 rounded text-sm">
                <option value="export">Export IA data to BloodHound</option>
                <option value="existing">Query existing BloodHound deployment</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Tenant ID</label>
              <input value={form.config.tenantId || ''}
                onChange={e => updateConfig('tenantId', e.target.value)}
                placeholder="Entra tenant ID"
                className="w-full p-2 border border-gray-200 rounded text-sm font-mono" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={form.config.autoExport !== false}
              onChange={e => updateConfig('autoExport', e.target.checked)} />
            Auto-export data before each scoring run
          </label>
        </div>
      )}

      {/* HTTP API-specific config */}
      {form.pluginType === 'http-api' && (
        <div className="p-3 bg-gray-50 rounded space-y-3">
          <h4 className="text-xs font-semibold text-gray-700">HTTP API Settings</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Request Path</label>
              <input value={form.config.requestPath || '/api/score'}
                onChange={e => updateConfig('requestPath', e.target.value)}
                className="w-full p-2 border border-gray-200 rounded text-sm font-mono" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Batch Size</label>
              <input type="number" value={form.config.batchSize || 500}
                onChange={e => updateConfig('batchSize', parseInt(e.target.value, 10) || 500)}
                className="w-full p-2 border border-gray-200 rounded text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Timeout (ms)</label>
            <input type="number" value={form.config.timeoutMs || 30000}
              onChange={e => updateConfig('timeoutMs', parseInt(e.target.value, 10) || 30000)}
              className="w-full p-2 border border-gray-200 rounded text-sm" />
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button onClick={() => onSave(form)}
          className="px-4 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700">
          {plugin ? 'Save Changes' : 'Add Plugin'}
        </button>
        <button onClick={onCancel}
          className="px-4 py-2 text-sm bg-gray-200 rounded hover:bg-gray-300">
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function RiskPluginsPage() {
  const { authFetch } = useAuth();
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | 'select' | 'wizard-bh' | plugin object
  const [actionLoading, setActionLoading] = useState({});

  const load = useCallback(() => {
    authFetch('/api/risk-plugins')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => setPlugins(d.data || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (form) => {
    try {
      const isUpdate = editing && editing !== 'new';
      const url = isUpdate ? `/api/risk-plugins/${editing.id}` : '/api/risk-plugins';
      const method = isUpdate ? 'PUT' : 'POST';
      const res = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditing(null);
      load();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  };

  const handleToggle = async (plugin) => {
    setActionLoading(s => ({ ...s, [`toggle-${plugin.id}`]: true }));
    try {
      await authFetch(`/api/risk-plugins/${plugin.id}/toggle`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !plugin.enabled }),
      });
      load();
    } catch (err) {
      alert(`Toggle failed: ${err.message}`);
    } finally {
      setActionLoading(s => ({ ...s, [`toggle-${plugin.id}`]: false }));
    }
  };

  const handleHealthCheck = async (plugin) => {
    setActionLoading(s => ({ ...s, [`health-${plugin.id}`]: true }));
    try {
      const res = await authFetch(`/api/risk-plugins/${plugin.id}/health`, { method: 'POST' });
      const data = await res.json();
      load();
      if (data.healthStatus === 'unhealthy') alert('Health check failed — endpoint unreachable.');
    } catch (err) {
      alert(`Health check error: ${err.message}`);
    } finally {
      setActionLoading(s => ({ ...s, [`health-${plugin.id}`]: false }));
    }
  };

  const handleExport = async (plugin) => {
    setActionLoading(s => ({ ...s, [`export-${plugin.id}`]: true }));
    try {
      const res = await authFetch(`/api/risk-plugins/${plugin.id}/export`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      alert(`Export completed: ${data.users || 0} users, ${data.groups || 0} groups, ${data.relationships || 0} relationships`);
      load();
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    } finally {
      setActionLoading(s => ({ ...s, [`export-${plugin.id}`]: false }));
    }
  };

  const handleDelete = async (plugin) => {
    if (!confirm(`Delete plugin "${plugin.displayName}"?`)) return;
    try {
      await authFetch(`/api/risk-plugins/${plugin.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  };

  if (loading) return <p className="text-sm text-gray-400 p-6">Loading plugins...</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Risk Scoring Plugins</h2>
          <p className="text-xs text-gray-500 mt-1">
            Integrate external risk scoring tools like BloodHound CE or custom APIs.
            Plugin scores contribute to a weighted external component in the scoring engine.
          </p>
        </div>
        {!editing && (
          <button onClick={() => setEditing('select')}
            className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700">
            + Add Plugin
          </button>
        )}
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 p-3 rounded">{error}</div>}

      {editing === 'select' && (
        <PluginTypeSelector
          onSelect={(type) => {
            if (type === 'bloodhound-ce') setEditing('wizard-bh');
            else setEditing('new');
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {editing === 'wizard-bh' && (
        <BloodHoundWizard
          authFetch={authFetch}
          onDone={() => { setEditing(null); load(); }}
          onCancel={() => setEditing(null)}
        />
      )}

      {(editing === 'new' || (editing && typeof editing === 'object')) && (
        <PluginForm
          plugin={editing === 'new' ? null : editing}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}

      {plugins.length === 0 && !editing && (
        <div className="text-center py-12 bg-gray-50 border border-gray-200 rounded-lg">
          <p className="text-sm text-gray-500">No plugins configured.</p>
          <p className="text-xs text-gray-400 mt-1">
            Add a BloodHound CE instance or custom HTTP scoring endpoint to enrich risk scores.
          </p>
        </div>
      )}

      {plugins.map(plugin => (
        <div key={plugin.id} className="bg-white border border-gray-200 rounded-lg p-5">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-900">{plugin.displayName}</h3>
                <StatusBadge status={plugin.healthStatus} />
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                  plugin.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-500'
                }`}>
                  {plugin.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {plugin.pluginType === 'bloodhound-ce' ? 'BloodHound CE' : 'Custom HTTP API'}
                {plugin.endpointUrl && <span className="ml-2 font-mono text-gray-400">{plugin.endpointUrl}</span>}
              </p>
              {plugin.description && <p className="text-xs text-gray-500 mt-0.5">{plugin.description}</p>}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={() => handleToggle(plugin)}
                disabled={actionLoading[`toggle-${plugin.id}`]}
                className={`px-2.5 py-1 text-xs rounded ${
                  plugin.enabled
                    ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                    : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                } disabled:opacity-50`}>
                {plugin.enabled ? 'Disable' : 'Enable'}
              </button>
              <button
                onClick={() => handleHealthCheck(plugin)}
                disabled={actionLoading[`health-${plugin.id}`]}
                className="px-2.5 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 disabled:opacity-50">
                {actionLoading[`health-${plugin.id}`] ? 'Checking...' : 'Health Check'}
              </button>
              {plugin.pluginType === 'bloodhound-ce' && (
                <button
                  onClick={() => handleExport(plugin)}
                  disabled={actionLoading[`export-${plugin.id}`]}
                  className="px-2.5 py-1 text-xs bg-purple-100 text-purple-700 rounded hover:bg-purple-200 disabled:opacity-50">
                  {actionLoading[`export-${plugin.id}`] ? 'Exporting...' : 'Export Data'}
                </button>
              )}
              <button
                onClick={() => setEditing(plugin)}
                className="px-2.5 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200">
                Edit
              </button>
              <button
                onClick={() => handleDelete(plugin)}
                className="px-2.5 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200">
                Delete
              </button>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-gray-500">Weight:</span>{' '}
              <span className="font-medium">{Math.round((plugin.defaultWeight || 0.15) * 100)}%</span>
            </div>
            <div>
              <span className="text-gray-500">Last health check:</span>{' '}
              <span className="font-medium">{plugin.lastHealthCheck ? new Date(plugin.lastHealthCheck).toLocaleString() : '—'}</span>
            </div>
            <div>
              <span className="text-gray-500">Last sync:</span>{' '}
              <span className="font-medium">{plugin.lastSyncAt ? new Date(plugin.lastSyncAt).toLocaleString() : '—'}</span>
            </div>
            <div>
              <span className="text-gray-500">Created:</span>{' '}
              <span className="font-medium">{new Date(plugin.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        </div>
      ))}

      {/* Weight preview when plugins are enabled */}
      {plugins.some(p => p.enabled) && (
        <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-lg">
          <h4 className="text-xs font-semibold text-indigo-900 mb-2">Effective Score Weights</h4>
          <WeightPreview plugins={plugins.filter(p => p.enabled)} />
        </div>
      )}
    </div>
  );
}

function WeightPreview({ plugins }) {
  const externalWeight = Math.min(
    plugins.reduce((sum, p) => sum + Number(p.defaultWeight || 0.15), 0),
    0.40
  );
  const scale = 1 - externalWeight;
  const weights = [
    { label: 'Direct (classifiers)', value: 0.50 * scale },
    { label: 'Membership', value: 0.20 * scale },
    { label: 'Structural', value: 0.10 * scale },
    { label: 'Propagated', value: 0.20 * scale },
    { label: 'External (plugins)', value: externalWeight },
  ];

  return (
    <div className="flex gap-1 h-6">
      {weights.map(w => (
        <div key={w.label}
          style={{ width: `${w.value * 100}%` }}
          className={`rounded text-[10px] font-medium flex items-center justify-center overflow-hidden ${
            w.label.includes('External')
              ? 'bg-indigo-500 text-white'
              : 'bg-indigo-200 text-indigo-800'
          }`}
          title={`${w.label}: ${Math.round(w.value * 100)}%`}>
          {Math.round(w.value * 100)}%
        </div>
      ))}
    </div>
  );
}
