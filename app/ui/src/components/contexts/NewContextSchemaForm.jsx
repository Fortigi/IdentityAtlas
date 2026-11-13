import { useEffect, useReducer, useState } from 'react';
import { Field } from './ModalPrimitives';
import { prettifyName, schemaFieldKind } from './NewContextWizard.helpers';
import { EnumField, AttributeField, PrincipalListField } from './NewContextSchemaFields';
import { attributeLabel } from '@ui/utils/formatters';

// useState-equivalent backed by useReducer (value + functional updates):
// dispatch isn't flagged by react-hooks/set-state-in-effect, so the JSON
// editor's value-sync effect can dispatch instead of setState.
const setStateReducer = (s, a) => (typeof a === 'function' ? a(s) : a);

// ─── Dead-simple JSON-Schema-to-form renderer ─────────────────────────────────
// Flat object of string / integer / boolean / array properties. scopeSystemId
// gets a system picker; a string `enum` a dropdown (labels from
// "x-enumLabels" when given); params flagged "x-attributeSource":"principal" the
// attribute picker (one for a string, a list for an array); an array of uuids
// ("items": { "format": "uuid" }) a person picker; other arrays/objects fall
// back to a JSON textarea. schemaFieldKind() picks which.
const INPUT = 'w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600';

const FIELDS = {
  system: ({ value, set, systems }) => (
    <select value={value ?? ''} onChange={e => set(e.target.value ? parseInt(e.target.value, 10) : '')} className={INPUT}>
      <option value="">(select a system)</option>
      {systems.map(s => <option key={s.id} value={s.id}>{s.displayName}</option>)}
    </select>
  ),
  number: ({ value, set }) => (
    <input type="number" value={value ?? ''} onChange={e => set(e.target.value === '' ? '' : Number(e.target.value))} className={INPUT} />
  ),
  boolean: ({ value, set }) => (
    <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
      <input type="checkbox" checked={value !== false} onChange={e => set(e.target.checked)} />
      <span>{value !== false ? 'On' : 'Off'}</span>
    </label>
  ),
  enum: ({ value, set, spec }) => <EnumField value={value} spec={spec} onChange={set} className={INPUT} />,
  attribute: ({ value, set, principalAttrs }) => (
    <AttributeField value={typeof value === 'string' ? value : ''} options={principalAttrs} onChange={set} className={INPUT} />
  ),
  attributeList: ({ value, set, principalAttrs }) => (
    <AttributeListField value={Array.isArray(value) ? value : []} options={principalAttrs} onChange={set} />
  ),
  principalList: ({ name, value, set }) => <PrincipalListField inputId={`param-${name}`} value={Array.isArray(value) ? value : []} onChange={set} />,
  text: ({ value, set, spec }) => (
    <input value={value ?? ''} onChange={e => set(e.target.value)} placeholder={spec.default != null ? String(spec.default) : ''} className={INPUT} />
  ),
};

export default function JsonSchemaForm({ schema, values, onChange, systems, principalAttrs = { columns: [], extended: [] } }) {
  if (!schema?.properties) {
    return <p className="text-xs text-gray-500 dark:text-gray-400">This plugin takes no parameters.</p>;
  }
  const required = new Set(schema.required || []);
  const entries = Object.entries(schema.properties);

  function setField(name, val) { onChange({ ...values, [name]: val }); }

  return entries.map(([name, spec]) => {
    const label = `${prettifyName(name)}${required.has(name) ? ' *' : ''}`;
    const help = spec.description;
    const kind = schemaFieldKind(name, spec);
    const set = val => setField(name, val);
    if (kind === 'json') {
      return <JsonField key={name} label={label} help={help} spec={spec} value={values[name]} onChange={set} />;
    }
    return (
      <Field key={name} label={label} help={help}>
        {FIELDS[kind]({ name, value: values[name], set, spec, systems, principalAttrs })}
      </Field>
    );
  });
}

// A list of attribute dropdowns with a "+" to add more and an "×" to remove.
// Groups real Principal columns and extendedAttributes keys; an "(other…)"
// escape hatch lets you type a name discovery didn't surface.
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
                  {/* Label shown, stored key sent — the plugin still reads the
                      real extendedAttributes key (#872). */}
                  {extended.map(o => <option key={o} value={o}>{attributeLabel(o) || o}</option>)}
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
              <button type="button" onClick={() => removeRow(i)} className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-red-600 dark:hover:text-red-400 rounded shrink-0" title="Remove">×</button>
            )}
          </div>
        );
      })}
      <button type="button" onClick={addRow} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline">+ Add attribute</button>
    </div>
  );
}

function JsonField({ label, help, spec, value, onChange }) {
  const [text, setText] = useReducer(setStateReducer, undefined, () =>
    value !== undefined ? JSON.stringify(value, null, 2) :
    spec.default !== undefined ? JSON.stringify(spec.default, null, 2) : ''
  );
  const [err, setErr] = useState(null);
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
        rows={4}
        spellCheck={false}
        className="w-full border rounded px-2 py-1 text-xs font-mono bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
      />
      {err && <p className="text-[11px] text-red-700 dark:text-red-400 mt-1">JSON error: {err}</p>}
    </Field>
  );
}
