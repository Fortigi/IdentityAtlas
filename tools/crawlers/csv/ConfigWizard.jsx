import { useState, useEffect, useCallback } from 'react';
import WizardShell from '@ui/components/WizardShell';
import { useDialog } from '@ui/components/dialogContext';
import { formatBytes } from '@ui/utils/formatters';
import CSV_SLOTS from './csv-slots.json';
import { FileReviewList, FileSettings, SlotSelect } from './MappingEditor.jsx';
import {
  DEFAULT_DELIMITER,
  autoMapColumns,
  buildFilesConfig,
  delimiterLabel,
  detectDelimiter,
  fileEntryFromConfig,
  mappedPairs,
  mappingErrors,
  missingRequiredColumns,
  normalizeDelimiter,
  parseCsvHeader,
} from './csvMapping.js';

// Re-exported: the mapping/validation rules moved into csvMapping.js so they can
// be unit-tested (and reused by MappingEditor) without rendering the wizard.
export { parseCsvHeader, missingRequiredColumns };

// The per-file upload limit is the SERVER's (UPLOAD_MAX_FILE_BYTES), read from
// GET /api/admin/crawler-uploads/limits. The wizard used to carry its own 1 GB
// copy; the server's default rose to 8 GiB and the copy did not, so a 1.8 GB
// export was refused here and never sent.
export const UPLOAD_LIMITS_URL = '/api/admin/crawler-uploads/limits';

// The staged files over the limit. None while the limit is unknown (still
// loading, or the request failed): the server enforces it regardless, and its
// refusal names the limit.
export function filesOverLimit(stagedFiles, maxFileBytes) {
  if (!Number.isFinite(maxFileBytes)) return [];
  return stagedFiles.filter(s => s.file.size > maxFileBytes);
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

// Read just the first line of a (possibly multi-GB) CSV without loading it whole:
// slice the first 64 KB, decode as UTF-8, and take everything up to the first
// newline. Returns '' when the file can't be read.
async function readFirstLine(file) {
  try {
    const text = await file.slice(0, 65536).text();
    const nl = text.search(/\r?\n/);
    return nl === -1 ? text : text.slice(0, nl);
  } catch { return ''; }
}

// The initial per-file settings for a file whose header has not been read yet.
// `detected` stays null until it has, so the row can say "reading…" instead of
// claiming a delimiter it has not seen evidence for.
function initialFileSettings(name, slot, configDelimiter, stored) {
  const base = fileEntryFromConfig(name, null, configDelimiter);
  return { ...base, ...(stored || {}), slot: stored?.slot ?? slot, headerLine: undefined, detected: null, delimiterTouched: !!stored };
}

export default function ConfigWizard({ onComplete, onCancel, initialConfig, isEdit, authFetch }) {
  const dialog = useDialog();
  // Steps: 1=info, 2=files, 3=review
  const [step, setStep] = useState(1);
  const [displayName, setDisplayName] = useState(initialConfig?.displayName || 'CSV Import');
  const [systemType, setSystemType] = useState(initialConfig?.systemType || 'CSV');
  const [systemName, setSystemName] = useState(initialConfig?.systemName || 'CSV Import');
  const [delimiter, setDelimiter] = useState(normalizeDelimiter(initialConfig?.delimiter) || DEFAULT_DELIMITER);
  // 'identityatlas' = the schema-shaped upload this crawler has always taken
  // (mapping bypassed entirely); 'custom' = map this source's own column names
  // onto the schema, applied by the crawler on every run.
  const [sourceFormat, setSourceFormat] = useState(initialConfig?.sourceFormat || 'identityatlas');

  // Files staged in the browser before upload (only on create)
  // and files already on the server (when editing).
  const [stagedFiles, setStagedFiles] = useState([]);    // [{ file: File }]
  const [serverFiles, setServerFiles] = useState([]);    // [{ name, sizeBytes, modifiedAt }]
  const [serverFolder, setServerFolder] = useState(null); // where a job reads this config's files
  const [maxFileBytes, setMaxFileBytes] = useState(null); // the server's per-file limit, once known
  const [savedConfigId, setSavedConfigId] = useState(initialConfig?.id || null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  // Per-file state, keyed by file name: { slot, delimiter, detected, mapping,
  // splitDelimiters, headerLine }. One map for staged and server files alike —
  // a file's delimiter and mapping are properties of the file, not of how it got
  // there, and this is exactly the shape the config stores.
  const [fileSettings, setFileSettings] = useState({});
  const patchFile = useCallback((name, patch) => {
    setFileSettings(prev => ({ ...prev, [name]: { ...prev[name], ...patch } }));
  }, []);

  const settingsFor = (name) => fileSettings[name] || initialFileSettings(name, matchSlot(name), delimiter, null);
  const headerColumnsFor = (name) => {
    const s = settingsFor(name);
    return s.headerLine ? parseCsvHeader(s.headerLine, s.delimiter).filter(Boolean) : [];
  };

  // The server's per-file upload limit.
  useEffect(() => {
    (async () => {
      try {
        const r = await authFetch(UPLOAD_LIMITS_URL);
        if (r.ok) setMaxFileBytes((await r.json()).maxFileBytes ?? null);
      } catch { /* unknown limit: the server still enforces it */ }
    })();
  }, [authFetch]);

  // Load existing files for edit mode, and each one's header row — re-mapping on
  // edit needs the real columns, and a file already on the server (or copied
  // straight into the folder) is not a browser File object we can slice.
  useEffect(() => {
    if (!savedConfigId) return;
    (async () => {
      try {
        const r = await authFetch(`/api/admin/crawler-configs/${savedConfigId}/files`);
        if (!r.ok) return;
        const j = await r.json();
        const files = j.files || [];
        setServerFiles(files);
        setServerFolder(j.folder || null);
        for (const f of files) {
          const stored = initialConfig?.files?.[f.name]
            ? fileEntryFromConfig(f.name, initialConfig.files, initialConfig.delimiter || DEFAULT_DELIMITER)
            : null;
          setFileSettings(prev => prev[f.name] ? prev : {
            ...prev,
            [f.name]: initialFileSettings(f.name, matchSlot(f.name), initialConfig?.delimiter || DEFAULT_DELIMITER, stored),
          });
          loadServerHeader(savedConfigId, f.name, stored);
        }
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialConfig is the wizard's immutable input; loadServerHeader is stable
  }, [savedConfigId, authFetch]);

  // One file's header line, from the server. Never fatal: without it the row
  // simply offers no column dropdowns and keeps whatever the config already said.
  const loadServerHeader = async (configId, name, stored) => {
    try {
      const r = await authFetch(`/api/admin/crawler-configs/${configId}/files/${encodeURIComponent(name)}/header`);
      if (!r.ok) return;
      const { header } = await r.json();
      applyHeaderLine(name, header || '', stored);
    } catch { /* ignore */ }
  };

  // Attach a file's header line and derive what depends on it: the detected
  // delimiter (unless the user or the stored config already set one) and the
  // exact-name mapping pre-fill (unless a mapping is already in place).
  const applyHeaderLine = (name, line, stored) => {
    setFileSettings(prev => {
      const cur = prev[name] || initialFileSettings(name, matchSlot(name), delimiter, stored);
      const fallback = cur.delimiter || delimiter;
      const detected = detectDelimiter(line, fallback);
      const effective = cur.delimiterTouched ? cur.delimiter : detected;
      const cols = parseCsvHeader(line, effective).filter(Boolean);
      const mapping = mappedPairs(cur.mapping).length ? cur.mapping : autoMapColumns(cols, cur.slot);
      return { ...prev, [name]: { ...cur, headerLine: line, detected, delimiter: effective, mapping } };
    });
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    // Filter to .csv only
    const csv = files.filter(f => /\.csv$/i.test(f.name));
    const mapped = csv.map(file => ({ file }));
    setStagedFiles(prev => {
      // Merge: replace files with same name, keep others
      const byName = new Map(prev.map(s => [s.file.name, s]));
      for (const m of mapped) byName.set(m.file.name, m);
      return Array.from(byName.values());
    });
    // headerLine starts undefined (= "reading"); the async read below fills it in
    // so we can detect the delimiter and validate columns against the slot.
    setFileSettings(prev => {
      const next = { ...prev };
      for (const m of mapped) next[m.file.name] = initialFileSettings(m.file.name, matchSlot(m.file.name), delimiter, null);
      return next;
    });
    e.target.value = ''; // allow re-selecting the same files
    for (const m of mapped) {
      readFirstLine(m.file).then(line => applyHeaderLine(m.file.name, line, null));
    }
  };

  // Changing a file's delimiter re-reads its columns, so the mapping dropdowns
  // and the required-column check follow it immediately.
  const setFileDelimiter = (name, value) => {
    const cur = settingsFor(name);
    const cols = parseCsvHeader(cur.headerLine, value).filter(Boolean);
    const stillValid = mappedPairs(cur.mapping).every(([, src]) => cols.some(c => c.toLowerCase() === String(src).toLowerCase()));
    patchFile(name, {
      delimiter: value,
      delimiterTouched: true,
      mapping: stillValid && mappedPairs(cur.mapping).length ? cur.mapping : autoMapColumns(cols, cur.slot),
    });
  };

  const setFileSlot = (name, slot) => {
    const cur = settingsFor(name);
    const cols = cur.headerLine ? parseCsvHeader(cur.headerLine, cur.delimiter).filter(Boolean) : [];
    patchFile(name, { slot, mapping: autoMapColumns(cols, slot), splitDelimiters: {} });
  };

  // What is wrong with one file, as display strings. In Identity Atlas-schema
  // mode that is the required-column check the wizard has always done; in custom
  // mode it is the POST-mapping check — validating the raw header there would
  // flag every mapped file as missing everything it was mapped to supply.
  const fileErrors = (name) => {
    const s = settingsFor(name);
    if (!s.slot || !s.headerLine) return [];
    const cols = parseCsvHeader(s.headerLine, s.delimiter).filter(Boolean);
    if (sourceFormat === 'custom') return mappingErrors(cols, s.mapping, s.slot);
    const slotDef = CSV_SLOTS.find(cs => cs.key === s.slot);
    const missing = missingRequiredColumns(cols, slotDef?.requiredColumns);
    return missing.length
      ? [`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. This file may be mapped to the wrong type — pick the right one, switch to a custom mapping, or check the schema template.`]
      : [];
  };

  const removeStaged = (name) => setStagedFiles(prev => prev.filter(s => s.file.name !== name));

  const removeServerFile = async (name) => {
    if (!savedConfigId) return;
    if (!(await dialog.confirm({ message: `Delete ${name} from the server?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await authFetch(`/api/admin/crawler-configs/${savedConfigId}/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
      setServerFiles(prev => prev.filter(f => f.name !== name));
    } catch (err) { setError(err.message); }
  };

  // Slot coverage check — used to enable/disable Save
  const allFiles = [
    ...serverFiles.map(f => ({ name: f.name, slot: settingsFor(f.name).slot, source: 'server' })),
    ...stagedFiles.map(s => ({ name: s.file.name, slot: settingsFor(s.file.name).slot, source: 'staged' })),
  ];
  const filledSlots = new Set(allFiles.map(f => f.slot).filter(Boolean));
  const requiredSlots = CSV_SLOTS.filter(s => s.required);
  const missingRequired = requiredSlots.filter(s => !filledSlots.has(s.key));
  const oversizedFiles = filesOverLimit(stagedFiles, maxFileBytes);
  const filesWithHeaderErrors = allFiles.filter(f => fileErrors(f.name).length > 0);
  const canSave = !uploading && !saving && missingRequired.length === 0 && allFiles.length > 0
    && oversizedFiles.length === 0 && filesWithHeaderErrors.length === 0;

  // Step 1 → 2 validation
  const canProceedFromInfo = displayName.trim() && systemName.trim() && systemType.trim() && delimiter;

  // The config's per-file section. Entries that say nothing beyond the canonical
  // defaults are left out, so a schema-shaped upload saves the same config it
  // always did and the crawler's bypass path is untouched.
  const filesPayload = () => buildFilesConfig(
    allFiles.map(f => ({ ...settingsFor(f.name), name: f.name })),
    { defaultDelimiter: delimiter, sourceFormat },
  );

  // Save handler — creates the config if needed, then uploads files
  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // 1. Create or update the config row
      const configPayload = { systemName, systemType, delimiter, sourceFormat, files: filesPayload() };
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

  // One file's row below its name: slot, delimiter, mapping panel, errors.
  // Shared by the staged and already-uploaded lists — the same file properties
  // either way.
  const renderFileSettings = (name) => (
    <FileSettings
      fileName={name}
      settings={settingsFor(name)}
      headerCols={headerColumnsFor(name)}
      errors={fileErrors(name)}
      mappingEnabled={sourceFormat === 'custom'}
      onDelimiterChange={v => setFileDelimiter(name, v)}
      onPatch={patch => patchFile(name, patch)}
    />
  );

  const slotSelect = (name) => (
    <SlotSelect fileName={name} slot={settingsFor(name).slot}
      invalid={fileErrors(name).length > 0} onChange={slot => setFileSlot(name, slot)} />
  );

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
          <fieldset>
            <legend className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">Source format</legend>
            <div className="space-y-1">
              <label className="flex items-start gap-2 text-sm dark:text-gray-200">
                <input type="radio" name="csv-source-format" value="identityatlas" className="mt-1"
                  checked={sourceFormat === 'identityatlas'} onChange={() => setSourceFormat('identityatlas')} />
                <span>
                  Identity Atlas schema
                  <span className="block text-xs text-gray-500 dark:text-gray-400">Files already use the canonical column names. Loaded as they are.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm dark:text-gray-200">
                <input type="radio" name="csv-source-format" value="custom" className="mt-1"
                  checked={sourceFormat === 'custom'} onChange={() => setSourceFormat('custom')} />
                <span>
                  Custom mapping
                  <span className="block text-xs text-gray-500 dark:text-gray-400">Upload the export as it is and map its columns onto the schema in the next step. The mapping is stored in the config and applied on every run.</span>
                </span>
              </label>
            </div>
          </fieldset>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-200">CSV delimiter</label>
            <select value={delimiter} onChange={e => setDelimiter(e.target.value)}
              aria-label="CSV delimiter"
              className="px-3 py-2 border border-gray-200 rounded text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
              <option value=";">Semicolon (;)</option>
              <option value=",">Comma (,)</option>
              {/* A literal tab, not the string "\t": a JSX attribute does not
                  process escapes, so value="\t" stored a backslash and a t —
                  which no CSV reader could bind, so Tab-configured jobs failed. */}
              <option value={'\t'}>Tab</option>
              <option value="|">Pipe (|)</option>
            </select>
            <p className="text-xs text-gray-500 mt-1 dark:text-gray-400">
              The default. Each file&apos;s own delimiter is detected after upload and can be overridden per file.
            </p>
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
            <div>
              {sourceFormat === 'custom'
                ? <>Upload the export <strong>as it is</strong>. Pick each file&apos;s object type, then map its columns onto the schema.</>
                : <>Upload CSV files in the <strong>Identity Atlas schema</strong>. Files are auto-mapped by name.</>}
              {maxFileBytes != null && <> Maximum <strong>{formatBytes(maxFileBytes)}</strong> per file.</>}
            </div>
            <div className="mt-1">
              <a href="/api/admin/crawlers/csv/upload-schema" download className="text-blue-700 underline hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-200">
                Download schema templates
              </a>
              <span className="text-blue-600 ml-2 dark:text-blue-400">— empty CSVs with the expected column headers.</span>
            </div>
          </div>

          {oversizedFiles.length > 0 && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300">
              The following {oversizedFiles.length === 1 ? 'file exceeds' : 'files exceed'} the server&apos;s {formatBytes(maxFileBytes)} per-file upload limit and cannot be uploaded. Remove {oversizedFiles.length === 1 ? 'it' : 'them'} to continue. An administrator can raise the limit with <code>UPLOAD_MAX_FILE_BYTES</code>, or — once the crawler exists — copy the file straight into its folder on the server.
              <ul className="mt-1 list-disc list-inside">
                {oversizedFiles.map(s => (
                  <li key={s.file.name}><span className="font-mono">{s.file.name}</span> ({formatBytes(s.file.size)})</li>
                ))}
              </ul>
            </div>
          )}

          {serverFolder && (
            <div className="text-xs text-gray-600 dark:text-gray-400">
              Large files can also be copied straight into this crawler&apos;s folder on the server, and are read exactly like uploaded ones:{' '}
              <code className="font-mono break-all text-gray-800 dark:text-gray-200">{serverFolder}</code>
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
                  <div key={s.file.name} className="p-2 text-sm dark:bg-gray-800">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="font-mono truncate dark:text-gray-200">{s.file.name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{formatBytes(s.file.size)}</div>
                      </div>
                      {slotSelect(s.file.name)}
                      <button onClick={() => removeStaged(s.file.name)}
                        className="ml-2 text-red-500 hover:text-red-700 text-xs dark:text-red-400 dark:hover:text-red-300">Remove</button>
                    </div>
                    {renderFileSettings(s.file.name)}
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
                {serverFiles.map(f => (
                  <div key={f.name} className="p-2 text-sm dark:bg-gray-800">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="font-mono truncate dark:text-gray-200">{f.name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{formatBytes(f.sizeBytes)} · {new Date(f.modifiedAt).toLocaleString()}</div>
                      </div>
                      {slotSelect(f.name)}
                      <button onClick={() => removeServerFile(f.name)}
                        className="ml-2 text-red-500 hover:text-red-700 text-xs dark:text-red-400 dark:hover:text-red-300">Delete</button>
                    </div>
                    {renderFileSettings(f.name)}
                  </div>
                ))}
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
            {/* Header/mapping errors gate this too, not just Save: a file that
                cannot load is worth fixing here, next to its own dropdowns,
                rather than at the end of the review step. */}
            <button onClick={() => setStep(3)}
              disabled={missingRequired.length > 0 || allFiles.length === 0 || filesWithHeaderErrors.length > 0}
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
            <div className="dark:text-gray-300"><span className="text-gray-500 dark:text-gray-400">Source format:</span> {sourceFormat === 'custom' ? 'Custom mapping' : 'Identity Atlas schema'}</div>
            <div className="dark:text-gray-300"><span className="text-gray-500 dark:text-gray-400">Default delimiter:</span> <code className="dark:text-gray-200">{delimiterLabel(delimiter)}</code></div>
            <div className="dark:text-gray-300"><span className="text-gray-500 dark:text-gray-400">Files:</span> {allFiles.length} total ({stagedFiles.length} new, {serverFiles.length} existing)</div>
          </div>
          <FileReviewList files={allFiles} settingsFor={settingsFor} mappingEnabled={sourceFormat === 'custom'} />
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
