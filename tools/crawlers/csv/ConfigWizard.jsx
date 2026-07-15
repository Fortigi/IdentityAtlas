import { useState, useEffect } from 'react';
import WizardShell from '@ui/components/WizardShell';
import CSV_SLOTS from './csv-slots.json';

export const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB — must match crawlerFiles.js

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B','KB','MB','GB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// Match an uploaded filename against the expected slots. Case-insensitive,
// also tolerates "users.csv", "USERS.CSV", and minor naming variants like
// "Org_Units.csv" or "OrgUnits.csv". Returns the slot key or null.
export function matchSlot(filename) {
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

export default function ConfigWizard({ onComplete, onCancel, initialConfig, isEdit, authFetch }) {
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
        const r = await authFetch(`/api/admin/crawler-configs/${savedConfigId}/files`);
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
      await authFetch(`/api/admin/crawler-configs/${savedConfigId}/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
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
  const oversizedFiles = stagedFiles.filter(s => s.file.size > MAX_FILE_BYTES);
  const canSave = !uploading && !saving && missingRequired.length === 0 && allFiles.length > 0 && oversizedFiles.length === 0;

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
        const r = await authFetch(`/api/admin/crawler-configs/${configId}/files`, {
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

  const csvSteps = [
    { n: 1, label: 'System info' },
    { n: 2, label: 'Upload files' },
    { n: 3, label: 'Review' },
  ];

  return (
    <WizardShell
      title={isEdit ? 'Edit CSV Crawler' : 'Add CSV Crawler'}
      onCancel={onCancel}
      steps={csvSteps}
      currentStep={step}
      onStepClick={setStep}
      allowAllSteps={isEdit}
      error={error}
    >

      {/* ── Step 1: System info ──────────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">Display name</label>
            <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
              placeholder="e.g. Omada Production"
              className="w-full px-3 py-2 border border-gray-200 rounded text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
            <p className="text-xs text-gray-500 mt-1 dark:text-gray-400">Shown on the configured crawlers card.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">System name</label>
              <input type="text" value={systemName} onChange={e => setSystemName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200" />
              <p className="text-xs text-gray-500 mt-1 dark:text-gray-400">Recorded in <code className="dark:text-gray-300">Systems.displayName</code>.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">System type</label>
              <input type="text" value={systemType} onChange={e => setSystemType(e.target.value)}
                placeholder="Omada / SailPoint / Custom"
                className="w-full px-3 py-2 border border-gray-200 rounded text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
              <p className="text-xs text-gray-500 mt-1 dark:text-gray-400">Used for grouping in the UI.</p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">CSV delimiter</label>
            <select value={delimiter} onChange={e => setDelimiter(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
              <option value=";">Semicolon (;)</option>
              <option value=",">Comma (,)</option>
              <option value="\t">Tab</option>
              <option value="|">Pipe (|)</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setStep(2)} disabled={!canProceedFromInfo}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
              Next: Upload files
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: File upload ──────────────────────────────────────────── */}
      {step === 2 && (
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm text-blue-800 dark:bg-blue-900/20 dark:border-blue-700 dark:text-blue-300">
            <div>Upload CSV files in the <strong>Identity Atlas schema</strong>. Files are auto-mapped by name. Maximum <strong>{fmtBytes(MAX_FILE_BYTES)}</strong> per file.</div>
            <div className="mt-1">
              <a href="/api/admin/crawlers/csv/upload-schema" download className="text-blue-700 underline hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-200">
                Download schema templates
              </a>
              <span className="text-blue-600 ml-2 dark:text-blue-400">— empty CSVs with the expected column headers. Use a transform script to convert your source data to this format.</span>
            </div>
          </div>

          {oversizedFiles.length > 0 && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300">
              The following {oversizedFiles.length === 1 ? 'file exceeds' : 'files exceed'} the {fmtBytes(MAX_FILE_BYTES)} upload limit and cannot be saved. Remove {oversizedFiles.length === 1 ? 'it' : 'them'} to continue, or mount the files directly into the Docker volume.
              <ul className="mt-1 list-disc list-inside">
                {oversizedFiles.map(s => (
                  <li key={s.file.name}><span className="font-mono">{s.file.name}</span> ({fmtBytes(s.file.size)})</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <label className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 cursor-pointer">
              Select folder
              <input type="file" multiple webkitdirectory="" directory="" onChange={handleFileSelect} className="hidden" />
            </label>
            <label className="px-4 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200 cursor-pointer dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
              Select files
              <input type="file" multiple accept=".csv" onChange={handleFileSelect} className="hidden" />
            </label>
          </div>

          {/* Staged files (not yet uploaded) */}
          {stagedFiles.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2 dark:text-gray-200">Staged files ({stagedFiles.length})</h4>
              <div className="border border-gray-200 rounded divide-y dark:border-gray-600 dark:divide-gray-700">
                {stagedFiles.map(s => (
                  <div key={s.file.name} className="flex items-center justify-between p-2 text-sm dark:bg-gray-800">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono truncate dark:text-gray-200">{s.file.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{fmtBytes(s.file.size)}</div>
                    </div>
                    <select value={s.slot || ''} onChange={e => setStagedSlot(s.file.name, e.target.value || null)}
                      className="ml-2 text-xs border border-gray-200 rounded px-1 py-0.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
                      <option value="">— Ignore —</option>
                      {CSV_SLOTS.map(slot => (
                        <option key={slot.key} value={slot.key}>{slot.label}{slot.required ? ' *' : ''}</option>
                      ))}
                    </select>
                    <button onClick={() => removeStaged(s.file.name)}
                      className="ml-2 text-red-500 hover:text-red-700 text-xs dark:text-red-400 dark:hover:text-red-300">Remove</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Files already on the server (edit mode) */}
          {serverFiles.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2 dark:text-gray-200">Already uploaded ({serverFiles.length})</h4>
              <div className="border border-gray-200 rounded divide-y dark:border-gray-600 dark:divide-gray-700">
                {serverFiles.map(f => {
                  const slot = matchSlot(f.name);
                  const slotLabel = CSV_SLOTS.find(s => s.key === slot)?.label || 'Unrecognized';
                  return (
                    <div key={f.name} className="flex items-center justify-between p-2 text-sm dark:bg-gray-800">
                      <div className="flex-1 min-w-0">
                        <div className="font-mono truncate dark:text-gray-200">{f.name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{fmtBytes(f.sizeBytes)} · {new Date(f.modifiedAt).toLocaleString()}</div>
                      </div>
                      <span className={`ml-2 px-2 py-0.5 rounded text-xs ${slot ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'}`}>{slotLabel}</span>
                      <button onClick={() => removeServerFile(f.name)}
                        className="ml-2 text-red-500 hover:text-red-700 text-xs dark:text-red-400 dark:hover:text-red-300">Delete</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Required-slot coverage */}
          <div className="bg-gray-50 border border-gray-200 rounded p-3 dark:bg-gray-700/50 dark:border-gray-600">
            <div className="text-xs font-semibold text-gray-700 mb-2 dark:text-gray-300">Required object types</div>
            <div className="flex flex-wrap gap-2">
              {CSV_SLOTS.map(slot => {
                const filled = filledSlots.has(slot.key);
                return (
                  <span key={slot.key} className={`px-2 py-1 rounded text-xs ${
                    filled ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' : (slot.required ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-gray-200 text-gray-600 dark:bg-gray-600 dark:text-gray-300')
                  }`} title={slot.hint || ''}>
                    {filled ? '✓ ' : (slot.required ? '✗ ' : '○ ')}{slot.label}{slot.required ? ' *' : ''}
                  </span>
                );
              })}
            </div>
            {missingRequired.length > 0 && (
              <div className="text-xs text-red-600 mt-2 dark:text-red-400">
                Missing required: {missingRequired.map(s => s.file).join(', ')}
              </div>
            )}
          </div>

          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className="px-4 py-2 bg-gray-100 rounded text-sm dark:bg-gray-700 dark:text-gray-300">Back</button>
            <button onClick={() => setStep(3)} disabled={missingRequired.length > 0 || allFiles.length === 0}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
              Next: Review
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Review ──────────────────────────────────────────────── */}
      {step === 3 && (
        <div className="space-y-4">
          <div className="bg-gray-50 border border-gray-200 rounded p-4 space-y-2 text-sm dark:bg-gray-700/50 dark:border-gray-600">
            <div><span className="text-gray-500 dark:text-gray-400">Display name:</span> <span className="font-medium dark:text-gray-200">{displayName}</span></div>
            <div className="dark:text-gray-300"><span className="text-gray-500 dark:text-gray-400">System:</span> {systemName} ({systemType})</div>
            <div className="dark:text-gray-300"><span className="text-gray-500 dark:text-gray-400">Delimiter:</span> <code className="dark:text-gray-200">{delimiter === '\t' ? '\\t' : delimiter}</code></div>
            <div className="dark:text-gray-300"><span className="text-gray-500 dark:text-gray-400">Files:</span> {allFiles.length} total ({stagedFiles.length} new, {serverFiles.length} existing)</div>
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(2)} className="px-4 py-2 bg-gray-100 rounded text-sm dark:bg-gray-700 dark:text-gray-300">Back</button>
            <button onClick={handleSave} disabled={!canSave}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
              {uploading ? 'Uploading...' : saving ? 'Saving...' : (isEdit ? 'Save changes' : 'Create crawler')}
            </button>
          </div>
        </div>
      )}
    </WizardShell>
  );
}
