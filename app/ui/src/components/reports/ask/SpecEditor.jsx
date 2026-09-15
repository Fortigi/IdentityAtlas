// PROTOTYPE — editable view of a natural-language report definition.
//
// The model's interpretation is shown as structured, editable criteria so the
// analyst can correct it before trusting the result: change a value, flip
// all/any, remove a condition, add one, pick columns. Everything is driven by
// the catalog from GET /api/nl-reports/catalog — no field list lives here.

const INPUT = 'rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
const LINK_BUTTON = 'text-sm text-blue-700 hover:underline dark:text-blue-300';

function fieldsOf(catalog, entity) {
  return catalog.entities[entity]?.fields || [];
}

function MatchSelect({ value, onChange, label }) {
  return (
    <select aria-label={label} className={INPUT} value={value} onChange={e => onChange(e.target.value)}>
      <option value="all">all</option>
      <option value="any">any</option>
    </select>
  );
}

function ValueInput({ field, op, value, onChange, catalog }) {
  if (!catalog.operators[op]?.needsValue) return null;
  const label = `${field.label} value`;
  if (op === 'withinLastDays' || op === 'olderThanDays' || field.type === 'number') {
    return <input aria-label={label} type="number" className={`${INPUT} w-24`} value={value ?? ''} onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
  }
  if (field.type === 'boolean') {
    return (
      <select aria-label={label} className={INPUT} value={String(value)} onChange={e => onChange(e.target.value === 'true')}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  if (field.type === 'enum' && field.values?.length) {
    return (
      <select aria-label={label} className={INPUT} value={value ?? ''} onChange={e => onChange(e.target.value)}>
        {!field.values.includes(value) && <option value={value ?? ''}>{String(value ?? '')}</option>}
        {field.values.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  }
  return <input aria-label={label} type="text" className={`${INPUT} w-48`} value={value ?? ''} onChange={e => onChange(e.target.value)} />;
}

function FieldCondition({ entity, condition, onChange, onRemove, catalog }) {
  const fields = fieldsOf(catalog, entity);
  const field = fields.find(f => f.name === condition.field) || fields[0];
  const ops = catalog.operatorsByType[field.type] || [];

  const setField = (name) => {
    const next = fields.find(f => f.name === name);
    const nextOps = catalog.operatorsByType[next.type];
    const op = nextOps.includes(condition.op) ? condition.op : nextOps[0];
    const value = next.type === 'boolean' ? true : next.type === 'enum' ? next.values?.[0] ?? '' : '';
    onChange({ type: 'field', field: name, op, value });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Field" className={INPUT} value={field.name} onChange={e => setField(e.target.value)}>
        {fields.map(f => <option key={f.name} value={f.name}>{f.label}</option>)}
      </select>
      <select aria-label="Operator" className={INPUT} value={condition.op} onChange={e => onChange({ ...condition, op: e.target.value })}>
        {ops.map(o => <option key={o} value={o}>{catalog.operators[o].label}</option>)}
      </select>
      <ValueInput field={field} op={condition.op} value={condition.value} catalog={catalog} onChange={v => onChange({ ...condition, value: v })} />
      <RemoveButton onRemove={onRemove} />
    </div>
  );
}

function RemoveButton({ onRemove }) {
  return (
    <button type="button" aria-label="Remove condition" onClick={onRemove}
      className="rounded px-1.5 text-gray-600 hover:bg-red-50 hover:text-red-700 dark:text-gray-400 dark:hover:bg-red-900/20 dark:hover:text-red-300">
      ✕
    </button>
  );
}

const newFieldCondition = (catalog, entity) => {
  const f = fieldsOf(catalog, entity).find(x => x.name === 'displayName') || fieldsOf(catalog, entity)[0];
  return { type: 'field', field: f.name, op: catalog.operatorsByType[f.type][0], value: '' };
};

function ConditionList({ entity, conditions, onChange, catalog, depth }) {
  const update = (i, c) => onChange(conditions.map((x, j) => (j === i ? c : x)));
  const remove = (i) => onChange(conditions.filter((_, j) => j !== i));
  return (
    <ul className="space-y-2">
      {conditions.map((c, i) => (
        <li key={i} className={depth > 0 ? 'border-l-2 border-gray-200 pl-3 dark:border-gray-600' : undefined}>
          <Condition entity={entity} condition={c} catalog={catalog} depth={depth}
            onChange={nc => update(i, nc)} onRemove={() => remove(i)} />
        </li>
      ))}
    </ul>
  );
}

function Condition({ entity, condition, onChange, onRemove, catalog, depth }) {
  if (condition.type === 'field') {
    return <FieldCondition entity={entity} condition={condition} onChange={onChange} onRemove={onRemove} catalog={catalog} />;
  }
  if (condition.type === 'relation') {
    const rel = catalog.entities[entity].relations.find(r => r.name === condition.relation);
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
          <select aria-label="Has or has not" className={INPUT} value={condition.quantifier} onChange={e => onChange({ ...condition, quantifier: e.target.value })}>
            <option value="some">has</option>
            <option value="none">has no</option>
          </select>
          <span className="font-medium">{rel?.label || condition.relation}</span>
          {condition.conditions.length > 0 && <span>where</span>}
          {condition.conditions.length > 1 && (
            <><MatchSelect label="Relation match" value={condition.match} onChange={m => onChange({ ...condition, match: m })} /><span>of:</span></>
          )}
          <RemoveButton onRemove={onRemove} />
        </div>
        <div className="pl-4">
          <ConditionList entity={rel.target} conditions={condition.conditions} catalog={catalog} depth={depth + 1}
            onChange={cs => onChange({ ...condition, conditions: cs })} />
          <button type="button" className={`${LINK_BUTTON} mt-1`}
            onClick={() => onChange({ ...condition, conditions: [...condition.conditions, newFieldCondition(catalog, rel.target)] })}>
            + condition on {rel.label.toLowerCase()}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
        <MatchSelect label="Group match" value={condition.match} onChange={m => onChange({ ...condition, match: m })} />
        <span>of:</span>
        <RemoveButton onRemove={onRemove} />
      </div>
      <div className="pl-4">
        <ConditionList entity={entity} conditions={condition.conditions} catalog={catalog} depth={depth + 1}
          onChange={cs => onChange({ ...condition, conditions: cs })} />
      </div>
    </div>
  );
}

export default function SpecEditor({ spec, catalog, onChange }) {
  const entity = catalog.entities[spec.entity];
  const toggleColumn = (key) => {
    const has = spec.columns.includes(key);
    onChange({ ...spec, columns: has ? spec.columns.filter(c => c !== key) : [...spec.columns, key] });
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
          <span className="font-semibold">{entity.label}s</span>
          {spec.conditions.length > 1 && (
            <><span>matching</span><MatchSelect label="Match" value={spec.match} onChange={m => onChange({ ...spec, match: m })} /><span>of:</span></>
          )}
          {spec.conditions.length === 1 && <span>where</span>}
        </div>
        <ConditionList entity={spec.entity} conditions={spec.conditions} catalog={catalog} depth={0}
          onChange={cs => onChange({ ...spec, conditions: cs })} />
        <button type="button" className={`${LINK_BUTTON} mt-2`}
          onClick={() => onChange({ ...spec, conditions: [...spec.conditions, newFieldCondition(catalog, spec.entity)] })}>
          + add condition
        </button>
      </div>

      <fieldset>
        <legend className="mb-1 text-sm font-semibold text-gray-800 dark:text-gray-200">Columns</legend>
        <div className="flex flex-wrap gap-1.5">
          {entity.columns.map(c => {
            const on = spec.columns.includes(c.key);
            return (
              <button key={c.key} type="button" aria-pressed={on} onClick={() => toggleColumn(c.key)}
                className={on
                  ? 'rounded-full border border-blue-600 bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-800 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-200'
                  : 'rounded-full border border-gray-300 px-2.5 py-0.5 text-xs text-gray-700 hover:border-blue-400 dark:border-gray-600 dark:text-gray-300'}>
                {c.label}
              </button>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
