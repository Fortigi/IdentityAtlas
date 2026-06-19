import { useState } from 'react';
import Stepper from '../../../app/ui/src/components/Stepper';
import useDocsUrl from '../../../app/ui/src/hooks/useDocsUrl';

export default function ConfigWizard({ onComplete, onCancel, authFetch }) {
  const docsLink = useDocsUrl();
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [registering, setRegistering] = useState(false);
  const [apiKey, setApiKey] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null); // track which field was copied

  const apiBaseUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/api`;

  const handleRegister = async () => {
    if (!name.trim()) return;
    setRegistering(true);
    setError(null);
    try {
      const r = await authFetch('/api/admin/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: name.trim(),
          description: description.trim() || null,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setApiKey(data.apiKey);
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setRegistering(false);
    }
  };

  const copyToClipboard = (text, field) => {
    navigator.clipboard.writeText(text);
    setCopied(field);
    setTimeout(() => setCopied(null), 2000);
  };

  const curlExample = `curl -X POST ${apiBaseUrl}/ingest/systems \\
  -H "Authorization: Bearer ${apiKey || '<your-api-key>'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "syncMode": "delta",
    "records": [{
      "displayName": "My System",
      "systemType": "Custom",
      "enabled": true,
      "syncEnabled": true
    }]
  }'`;

  const pythonExample = `import requests

API = "${apiBaseUrl}"
KEY = "${apiKey || '<your-api-key>'}"
headers = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

# 1. Register a system
r = requests.post(f"{API}/ingest/systems", headers=headers, json={
    "syncMode": "delta",
    "records": [{"displayName": "My System", "systemType": "Custom",
                 "enabled": True, "syncEnabled": True}]
})
system_id = r.json()["systemIds"][0]

# 2. Push users
requests.post(f"{API}/ingest/principals", headers=headers, json={
    "systemId": system_id, "syncMode": "delta",
    "records": [{"externalId": "user-1", "displayName": "Alice",
                 "principalType": "User", "accountEnabled": True}]
})

# 3. Push resources
requests.post(f"{API}/ingest/resources", headers=headers, json={
    "systemId": system_id, "syncMode": "delta",
    "records": [{"externalId": "role-1", "displayName": "Admin Role",
                 "resourceType": "Role", "enabled": True}]
})

# 4. Push assignments (who has access to what)
requests.post(f"{API}/ingest/resource-assignments", headers=headers, json={
    "systemId": system_id, "syncMode": "delta",
    "records": [{"principalExternalId": "user-1",
                 "resourceExternalId": "role-1",
                 "assignmentType": "Direct"}]
})`;

  const powershellExample = `$api = "${apiBaseUrl}"
$key = "${apiKey || '<your-api-key>'}"
$headers = @{ Authorization = "Bearer $key"; 'Content-Type' = 'application/json' }

# 1. Register a system
$r = Invoke-RestMethod -Uri "$api/ingest/systems" -Method Post -Headers $headers -Body (@{
    syncMode = 'delta'; records = @(@{
        displayName = 'My System'; systemType = 'Custom'; enabled = $true; syncEnabled = $true
    })
} | ConvertTo-Json -Depth 5)
$systemId = $r.systemIds[0]

# 2. Push users
Invoke-RestMethod -Uri "$api/ingest/principals" -Method Post -Headers $headers -Body (@{
    systemId = $systemId; syncMode = 'delta'; records = @(@{
        externalId = 'user-1'; displayName = 'Alice'; principalType = 'User'; accountEnabled = $true
    })
} | ConvertTo-Json -Depth 5)`;

  const connectorSteps = [
    { n: 1, label: 'Register' },
    { n: 2, label: 'API Key' },
    { n: 3, label: 'Getting started' },
  ];

  return (
    <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg dark:bg-gray-800 dark:border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold dark:text-white">Custom Connector</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-700 text-sm dark:text-gray-400 dark:hover:text-gray-200">Cancel</button>
      </div>

      <div className="mb-5"><Stepper steps={connectorSteps} current={step} /></div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm dark:bg-red-900/20 dark:border-red-700 dark:text-red-300">{error}</div>
      )}

      {/* Step 1: Name + register */}
      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Register a custom connector to push data from any system into Identity Atlas using the Ingest API.
            You'll get an API key to authenticate your requests.
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">Connector name *</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. SAP HR Export, ServiceNow CMDB, Okta Sync"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">Description (optional)</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="What system does this connector pull data from?"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onCancel} className="px-4 py-2 bg-gray-100 rounded text-sm dark:bg-gray-700 dark:text-gray-300">Cancel</button>
            <button onClick={handleRegister} disabled={!name.trim() || registering}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
              {registering ? 'Registering...' : 'Register Connector'}
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Show API key (one-time) */}
      {step === 2 && apiKey && (
        <div className="space-y-4">
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg dark:bg-amber-900/20 dark:border-amber-700">
            <p className="text-sm font-medium text-amber-800 mb-2 dark:text-amber-300">
              Save this API key now — it will not be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded text-sm font-mono break-all dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200">{apiKey}</code>
              <button onClick={() => copyToClipboard(apiKey, 'key')}
                className="px-3 py-2 bg-amber-600 text-white rounded text-sm hover:bg-amber-700 whitespace-nowrap">
                {copied === 'key' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">API Base URL</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded text-sm font-mono dark:bg-gray-700/50 dark:border-gray-600 dark:text-gray-200">{apiBaseUrl}</code>
              <button onClick={() => copyToClipboard(apiBaseUrl, 'url')}
                className="px-3 py-2 bg-gray-200 rounded text-sm hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
                {copied === 'url' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
          <div className="flex justify-end">
            <button onClick={() => setStep(3)}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
              Next: Getting Started
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Docs, spec download, code examples */}
      {step === 3 && (
        <div className="space-y-5">
          {/* Quick links */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <a href={`${apiBaseUrl}/docs`} target="_blank" rel="noopener noreferrer"
              className="flex flex-col items-center p-4 border-2 rounded-lg hover:border-blue-400 hover:shadow-md transition-all text-center dark:border-gray-700 dark:hover:border-blue-500">
              <span className="text-2xl mb-1">📖</span>
              <span className="font-medium text-sm dark:text-gray-200">Swagger UI</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">Interactive API explorer</span>
            </a>
            <a href={`${apiBaseUrl}/openapi.json`} download="identity-atlas-openapi.json"
              className="flex flex-col items-center p-4 border-2 rounded-lg hover:border-blue-400 hover:shadow-md transition-all text-center dark:border-gray-700 dark:hover:border-blue-500">
              <span className="text-2xl mb-1">📄</span>
              <span className="font-medium text-sm dark:text-gray-200">Download OpenAPI Spec</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">JSON format</span>
            </a>
            <a href={docsLink('/architecture/csv-import-schema/')} target="_blank" rel="noopener noreferrer"
              className="flex flex-col items-center p-4 border-2 rounded-lg hover:border-blue-400 hover:shadow-md transition-all text-center dark:border-gray-700 dark:hover:border-blue-500">
              <span className="text-2xl mb-1">📋</span>
              <span className="font-medium text-sm dark:text-gray-200">CSV Schema Reference</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">Field definitions for all entity types</span>
            </a>
          </div>

          {/* Code examples */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-2 dark:text-gray-200">Quick Start Examples</h4>
            <ExampleTabs examples={[
              { label: 'curl', code: curlExample },
              { label: 'Python', code: pythonExample },
              { label: 'PowerShell', code: powershellExample },
            ]} onCopy={copyToClipboard} copied={copied} />
          </div>

          {/* Ingest flow explanation */}
          <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 space-y-2 dark:bg-gray-700/50 dark:border-gray-600 dark:text-gray-300">
            <p className="font-medium dark:text-gray-200">How the Ingest API works:</p>
            <ol className="list-decimal list-inside space-y-1 text-gray-600 dark:text-gray-400">
              <li><strong>Systems</strong> — register your source system (once)</li>
              <li><strong>Principals</strong> — push user accounts (with systemId from step 1)</li>
              <li><strong>Resources</strong> — push groups, roles, apps, or any permission-granting entity</li>
              <li><strong>Resource Assignments</strong> — push who has access to what</li>
              <li><strong>Resource Relationships</strong> — push role-to-resource nesting (optional)</li>
              <li><strong>Identities + Identity Members</strong> — push cross-system account correlation (optional)</li>
              <li><strong>Refresh Views</strong> — call <code className="dark:text-gray-300">POST /ingest/refresh-views</code> after a full sync to update the matrix</li>
            </ol>
            <p className="mt-2">
              Use <code className="dark:text-gray-300">syncMode: "full"</code> to replace all data for a system, or <code className="dark:text-gray-300">"delta"</code> to upsert incrementally.
            </p>
          </div>

          <div className="flex justify-end">
            <button onClick={onComplete}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Tab switcher for code examples
function ExampleTabs({ examples, onCopy, copied }) {
  const [active, setActive] = useState(0);
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden dark:border-gray-700">
      <div className="flex border-b bg-gray-50 dark:bg-gray-700/50 dark:border-gray-700">
        {examples.map((ex, i) => (
          <button key={ex.label} onClick={() => setActive(i)}
            className={`px-4 py-2 text-sm font-medium ${
              i === active ? 'bg-white border-b-2 border-blue-500 text-blue-700 dark:bg-gray-800 dark:text-blue-400' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }`}>
            {ex.label}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={() => onCopy(examples[active].code, `example-${active}`)}
          className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 self-center mr-2 dark:text-gray-400 dark:hover:text-gray-200">
          {copied === `example-${active}` ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="p-4 text-xs font-mono overflow-x-auto bg-gray-900 text-gray-100 max-h-80">
        {examples[active].code}
      </pre>
    </div>
  );
}
