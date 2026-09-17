// A form rendered from a JSON-Schema `properties` block.
//
// Both the context plugins and the report templates describe their inputs the
// same way — a `parametersSchema` with `type`/`title`/`description`/`enum` per
// property — because both are plugin contracts built on the same shape. So they
// get the same form: the caller owns the values and supplies `onChange`, and
// nothing here knows which plugin or report it is drawing.
//
// Extracted from PluginsPage.jsx when the parameterised reports needed it; a
// third caller should use it too rather than growing a second one.

const INPUT_CLASS = 'w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 '
  + 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100';

/**
 * One editable input for a single JSON-schema property. Exported for callers
 * that need a single field outside a full form.
 */
export function FieldInput({ prop, value, onChange, id }) {
  if (Array.isArray(prop.enum)) {
    return (
      <select id={id} className={INPUT_CLASS} value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">— none —</option>
        {prop.enum.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (prop.type === 'boolean') {
    return (
      <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        {value ? 'On' : 'Off'}
      </label>
    );
  }
  if (prop.type === 'integer' || prop.type === 'number') {
    return (
      <input id={id} type="number" className={INPUT_CLASS} value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
    );
  }
  if (prop.type === 'array') {
    const text = Array.isArray(value) ? value.join(', ') : (value || '');
    return (
      <input id={id} type="text" className={INPUT_CLASS} placeholder="comma, separated, values" value={text}
        onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
    );
  }
  return (
    <input id={id} type="text" className={INPUT_CLASS} value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)} />
  );
}

/**
 * The whole form. `emptyHint` is what to say when the schema declares no
 * properties — "this plugin has no parameters" and "this report has no
 * parameters" are the same statement about different things, so the caller
 * words it.
 */
export default function SchemaConfigForm({ schema, params, onChange, emptyHint, idPrefix = 'param' }) {
  const props = schema?.properties || {};
  const keys = Object.keys(props);
  if (keys.length === 0) {
    return emptyHint
      ? <p className="text-sm text-gray-500 dark:text-gray-400">{emptyHint}</p>
      : null;
  }
  return (
    <div className="space-y-3 max-w-xl">
      {keys.map((k) => {
        const p = props[k];
        const id = `${idPrefix}-${k}`;
        return (
          <div key={k}>
            {/* A real <label>, not a placeholder: the field has to be reachable
                by name for a screen reader and for a test. */}
            <label htmlFor={id} className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              {p.title || k}
            </label>
            {p.description && <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">{p.description}</p>}
            <FieldInput id={id} prop={p} value={params[k]} onChange={(nv) => onChange({ ...params, [k]: nv })} />
          </div>
        );
      })}
    </div>
  );
}
