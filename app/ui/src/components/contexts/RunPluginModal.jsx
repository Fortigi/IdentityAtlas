import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthGate';
import { Modal, Field, ErrorBox, PrimaryButton, SecondaryButton } from './ModalPrimitives';
import { targetTypeMeta } from '../../utils/contextStyles';

// Run a registered context-algorithm plugin.
//
// Flow:
//   1. Pick a plugin from the registry (grouped by target type).
//   2. Fill in required parameters (form generated from parametersSchema).
//   3. "Dry run" — preview counts + a handful of samples without writing.
//   4. "Run" — queues a real run; onRunStarted(runId) lets the caller open
//      the run-detail tab.

export default function RunPluginModal({ open, onClose, onRunStarted }) {
  const { authFetch } = useAuth();

  const [plugins, setPlugins] = useState([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginsError, setPluginsError] = useState(null);

  const [selected, setSelected] = useState(null);   // plugin object
  const [params, setParams] = useState({});         // form values
  const [systems, setSystems] = useState([]);
  const [principalAttrs, setPrincipalAttrs] = useState({ columns: [], extended: [] }); // for the name-field picker

  const [dryRunning, setDryRunning] = useState(false);
  const [dryResult, setDryResult] = useState(null);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  // Load plugins + systems when the modal opens.
  useEffect(() => {
    if (!open) return;
    (async () => {
      setPluginsLoading(true); setPluginsError(null);
      try {
        const [pr, sr, cr] = await Promise.all([
          authFetch('/api/context-plugins'),
          authFetch('/api/systems'),
          authFetch('/api/context-plugins/principal-attributes'),
        ]);
        if (!pr.ok) throw new Error(`plugins HTTP ${pr.status}`);
        const pbody = await pr.json();
        setPlugins(pbody.data || []);
        if (sr.ok) {
          const sbody = await sr.json();
          setSystems(sbody.data || sbody || []);
        }
        if (cr.ok) {
          const ab = await cr.json();
          // { columns: [...real cols...], extended: [...extendedAttributes keys...] }
          setPrincipalAttrs({ columns: ab.columns || [], extended: ab.extended || [] });
        }
      } catch (err) {
        setPluginsError(err.message || 'Failed to load plugins');
      } finally {
        setPluginsLoading(false);
      }
    })();
  }, [open, authFetch]);

  // Reset per-open state.
  useEffect(() => {
    if (!open) {
      setSelected(null); setParams({}); setDryResult(null);
      setError(null); setDryRunning(false); setRunning(false);
    }
  }, [open]);

  // When a plugin is selected, seed params with schema defaults.
  useEffect(() => {
    if (!selected) { setParams({}); setDryResult(null); return; }
    const defaults = {};
    const props = selected.parametersSchema?.properties || {};
    for (const [name, spec] of Object.entries(props)) {
      if (spec?.default !== undefined) defaults[name] = spec.default;
    }
    setParams(defaults);
    setDryResult(null);
  }, [selected]);

  const grouped = useMemo(() => groupByTargetType(plugins), [plugins]);

  const missing = useMemo(() => {
    if (!selected) return [];
    return (selected.parametersSchema?.required || []).filter(n => {
      const v = params[n];
      return v === undefined || v === null || v === '';
    });
  }, [selected, params]);
  const canRun = !!selected && missing.length === 0 && !running && !dryRunning;

  if (!open) return null;

  async function dryRun() {
    if (!selected) return;
    setDryRunning(true); setError(null); setDryResult(null);
    try {
      const r = await authFetch(`/api/context-plugins/${selected.name}/dry-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setDryResult(body);
    } catch (err) {
      setError(err.message || 'Dry-run failed');
    } finally {
      setDryRunning(false);
    }
  }

  async function run() {
    if (!selected) return;
    setRunning(true); setError(null);
    try {
      const r = await authFetch(`/api/context-plugins/${selected.name}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      onRunStarted?.(body.runId);
      onClose();
    } catch (err) {
      setError(err.message || 'Run failed');
      setRunning(false);
    }
  }

  return (
    <Modal
      title="Run plugin"
      subtitle={selected ? selected.displayName : 'Pick an algorithm to generate a context tree.'}
      onClose={onClose}
      width={620}
      dismissOnBackdrop={false}
    >
      {pluginsLoading && <div className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500">Loading plugins…</div>}
      {pluginsError && <ErrorBox message={pluginsError} />}

      {!selected && !pluginsLoading && (
        <PluginPicker grouped={grouped} onPick={setSelected} />
      )}

      {selected && (
        <>
          <div className="mb-3 flex items-center gap-2 text-[11px]">
            <button onClick={() => setSelected(null)} className="text-blue-600 dark:text-blue-400 hover:underline">← Back to plugin list</button>
          </div>

          <div className="space-y-3">
            <JsonSchemaForm
              schema={selected.parametersSchema}
              values={params}
              onChange={setParams}
              systems={systems}
              principalAttrs={principalAttrs}
            />
          </div>

          <ErrorBox message={error} />

          {dryResult && (
            <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded p-3 bg-gray-50 dark:bg-gray-700/50">
              <div className="text-xs font-semibold text-gray-800 dark:text-gray-200">
                Dry run: {dryResult.contextCount} contexts · {dryResult.memberCount} members
              </div>
              <DryRunSamples samples={dryResult.samples} />
            </div>
          )}

          <div className="mt-4 flex items-center justify-between gap-2">
            <div className="text-[11px] text-gray-500 dark:text-gray-400 dark:text-gray-500">
              {missing.length > 0 ? `Missing: ${missing.join(', ')}` : 'Ready to dry-run or execute.'}
            </div>
            <div className="flex items-center gap-2">
              <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
              <SecondaryButton onClick={dryRun} disabled={!canRun}>
                {dryRunning ? 'Running…' : 'Dry run'}
              </SecondaryButton>
              <PrimaryButton onClick={run} disabled={!canRun}>
                {running ? 'Starting…' : 'Run'}
              </PrimaryButton>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

// ─── Plugin picker (grouped by target type) ───────────────────────────────────
function PluginPicker({ grouped, onPick }) {
  if (grouped.length === 0) {
    return <p className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500">No plugins are registered.</p>;
  }
  return (
    <div className="space-y-3">
      {grouped.map(([targetType, items]) => {
        const t = targetTypeMeta(targetType);
        return (
          <div key={targetType}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass}`}>{t.label}</span>
              <span className="text-[11px] text-gray-500 dark:text-gray-400 dark:text-gray-500">· {items.length}</span>
            </div>
            <ul className="border border-gray-200 dark:border-gray-700 rounded divide-y divide-gray-100">
              {items.map(p => (
                <li key={p.name}>
                  <button
                    onClick={() => onPick(p)}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:bg-gray-700/50"
                  >
                    <div className="text-sm font-medium text-gray-900 dark:text-white">{p.displayName}</div>
                    {p.description && <div className="text-[11px] text-gray-500 dark:text-gray-400 dark:text-gray-500 line-clamp-2">{p.description}</div>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function groupByTargetType(plugins) {
  const map = new Map();
  for (const p of plugins) {
    if (!map.has(p.targetType)) map.set(p.targetType, []);
    map.get(p.targetType).push(p);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// ─── Dead-simple JSON-Schema-to-form renderer ─────────────────────────────────
// Handles only what the current plugin registry uses: a flat object with
// string / integer properties, optional defaults, required list. scopeSystemId
// gets a system-picker instead of a number input for ergonomics.
function JsonSchemaForm({ schema, values, onChange, systems, principalAttrs = [] }) {
  if (!schema?.properties) {
    return <p className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500">This plugin takes no parameters.</p>;
  }
  const required = new Set(schema.required || []);
  const entries = Object.entries(schema.properties);

  function setField(name, val) {
    onChange({ ...values, [name]: val });
  }

  return entries.map(([name, spec]) => {
    const isRequired = required.has(name);
    const label = `${prettifyName(name)}${isRequired ? ' *' : ''}`;
    const help = spec.description;

    if (name === 'scopeSystemId') {
      return (
        <Field key={name} label={label} help={help}>
          <select
            value={values[name] ?? ''}
            onChange={e => setField(name, e.target.value ? parseInt(e.target.value, 10) : '')}
            className="w-full border rounded px-2 py-1 text-sm"
          >
            <option value="">(select a system)</option>
            {systems.map(s => <option key={s.id} value={s.id}>{s.displayName}</option>)}
          </select>
        </Field>
      );
    }
    if (spec.type === 'integer' || spec.type === 'number') {
      return (
        <Field key={name} label={label} help={help}>
          <input
            type="number"
            value={values[name] ?? ''}
            onChange={e => setField(name, e.target.value === '' ? '' : Number(e.target.value))}
            className="w-full border rounded px-2 py-1 text-sm"
          />
        </Field>
      );
    }
    // Array of attribute names → friendly dropdown list with add/remove,
    // populated from the real Principal columns. Marked in the schema with
    // "x-attributeSource": "principal".
    if (spec.type === 'array' && spec['x-attributeSource'] === 'principal') {
      return (
        <Field key={name} label={label} help={help}>
          <AttributeListField
            value={Array.isArray(values[name]) ? values[name] : []}
            options={principalAttrs}
            onChange={val => setField(name, val)}
          />
        </Field>
      );
    }
    if (spec.type === 'array' || spec.type === 'object') {
      // Paste JSON. The form stores the *parsed* value; invalid JSON is
      // surfaced inline and the Run button will stay disabled via the
      // "missing" check upstream if the field is required.
      return (
        <JsonField
          key={name}
          label={label}
          help={help}
          spec={spec}
          value={values[name]}
          onChange={val => setField(name, val)}
        />
      );
    }
    // default: string
    return (
      <Field key={name} label={label} help={help}>
        <input
          value={values[name] ?? ''}
          onChange={e => setField(name, e.target.value)}
          placeholder={spec.default != null ? String(spec.default) : ''}
          className="w-full border rounded px-2 py-1 text-sm"
        />
      </Field>
    );
  });
}

// A list of attribute dropdowns with a "+" to add more and an "×" to remove —
// the friendly alternative to hand-editing a JSON array of attribute names.
// Always renders at least one row. The <select> groups real Principal columns
// and extendedAttributes keys under separate headings; an "(other…)" escape
// hatch lets you type a name discovery didn't surface.
function AttributeListField({ value, options, onChange }) {
  const columns = options?.columns || [];
  const extended = options?.extended || [];
  const known = new Set([...columns, ...extended]);
  const rows = value.length > 0 ? value : [''];
  const OTHER = '__other__';

  function update(i, v) {
    const next = rows.slice();
    next[i] = v;
    onChange(next.filter(x => x !== '' && x !== OTHER));
  }
  function addRow() { onChange([...rows.filter(Boolean), '']); }
  function removeRow(i) {
    const next = rows.slice();
    next.splice(i, 1);
    onChange(next.filter(Boolean));
  }

  return (
    <div className="space-y-1.5">
      {rows.map((val, i) => {
        const isKnown = val === '' || known.has(val);
        return (
          <div key={i} className="flex items-center gap-1.5">
            <select
              value={isKnown ? val : OTHER}
              onChange={e => update(i, e.target.value === OTHER ? '' : e.target.value)}
              className="flex-1 border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
            >
              <option value="">(select an attribute…)</option>
              {columns.length > 0 && (
                <optgroup label="Attributes">
                  {columns.map(o => <option key={o} value={o}>{o}</option>)}
                </optgroup>
              )}
              {extended.length > 0 && (
                <optgroup label="Extended attributes">
                  {extended.map(o => <option key={o} value={o}>{o}</option>)}
                </optgroup>
              )}
              <option value={OTHER}>(other — type a name)</option>
            </select>
            {!isKnown && (
              <input
                value={val}
                onChange={e => update(i, e.target.value)}
                placeholder="attribute name"
                className="flex-1 border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
              />
            )}
            {rows.length > 1 && (
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-red-600 dark:hover:text-red-400 rounded shrink-0"
                title="Remove"
              >×</button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={addRow}
        className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
      >+ Add attribute</button>
    </div>
  );
}

function JsonField({ label, help, spec, value, onChange }) {
  const [text, setText] = useState(() =>
    value !== undefined ? JSON.stringify(value, null, 2) :
    spec.default !== undefined ? JSON.stringify(spec.default, null, 2) : ''
  );
  const [err, setErr] = useState(null);
  // Keep text in sync when caller resets params (e.g. switching plugins).
  useEffect(() => {
    if (value === undefined || value === null) return;
    const current = JSON.stringify(value, null, 2);
    setText(prev => prev === current ? prev : current);
  }, [value]);

  function handleChange(newText) {
    setText(newText);
    if (newText.trim() === '') { setErr(null); onChange(undefined); return; }
    try {
      const parsed = JSON.parse(newText);
      setErr(null);
      onChange(parsed);
    } catch (e) {
      setErr(e.message);
      onChange(undefined);
    }
  }

  return (
    <Field label={label} help={help}>
      <textarea
        value={text}
        onChange={e => handleChange(e.target.value)}
        rows={5}
        spellCheck={false}
        className="w-full border rounded px-2 py-1 text-xs font-mono"
      />
      {err && <p className="text-[11px] text-red-700 dark:text-red-400 mt-1">JSON error: {err}</p>}
    </Field>
  );
}

function prettifyName(name) {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, c => c.toUpperCase())
    .trim();
}

function DryRunSamples({ samples }) {
  if (!samples) return null;
  const ctxs = samples.contexts || [];
  const mbrs = samples.members || [];
  if (ctxs.length === 0 && mbrs.length === 0) {
    return <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400 dark:text-gray-500">No preview rows.</p>;
  }
  return (
    <div className="mt-2 space-y-2">
      {ctxs.length > 0 && (
        <details>
          <summary className="text-[11px] text-gray-700 dark:text-gray-300 cursor-pointer">Preview contexts ({ctxs.length})</summary>
          <ul className="text-[11px] text-gray-600 dark:text-gray-400 dark:text-gray-500 mt-1 pl-4 list-disc">
            {ctxs.map((c, i) => (
              <li key={i}>{c.displayName} <span className="text-gray-600 dark:text-gray-500">({c.externalId})</span></li>
            ))}
          </ul>
        </details>
      )}
      {mbrs.length > 0 && (
        <details>
          <summary className="text-[11px] text-gray-700 dark:text-gray-300 cursor-pointer">Preview members ({mbrs.length})</summary>
          <ul className="text-[11px] text-gray-600 dark:text-gray-400 dark:text-gray-500 mt-1 pl-4 list-disc">
            {mbrs.slice(0, 10).map((m, i) => (
              <li key={i}>{m.memberId} → {m.contextExternalId}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
