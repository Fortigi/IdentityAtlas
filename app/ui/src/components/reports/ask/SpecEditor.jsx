// PROTOTYPE — editable view of a natural-language report definition.
//
// The model's interpretation is shown as structured, editable criteria so the
// analyst can correct it before trusting the result: change a value, flip
// all/any, remove a condition, add one, pick columns. Everything is driven by
// the catalog from GET /api/nl-reports/catalog — no field list lives here.

import CompareCondition, { newCompareCondition } from './CompareCondition';

const INPUT = 'rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
const LINK_BUTTON = 'text-sm text-blue-700 hover:underline dark:text-blue-300';

function fieldsOf(catalog, entity) {
  return catalog.entities[entity]?.fields || [];
}

// The catalog's fields first, then this deployment's own attributes in a group of
// their own. An install can have hundreds of those, and an undifferentiated list
// would bury "Department" somewhere below "extensionAttribute7".
function FieldOptions({ fields }) {
  const own = fields.filter(f => !f.discovered);
  const discovered = fields.filter(f => f.discovered);
  return (
    <>
      {own.map(f => <option key={f.name} value={f.name}>{f.label}</option>)}
      {discovered.length > 0 && (
        <optgroup label="From your data">
          {discovered.map(f => <option key={f.name} value={f.name}>{f.label}</option>)}
        </optgroup>
      )}
    </>
  );
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
        <FieldOptions fields={fields} />
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
  if (condition.type === 'compare') {
    return <CompareCondition entity={entity} condition={condition} catalog={catalog} onChange={onChange} onRemove={onRemove} RemoveButton={RemoveButton} />;
  }
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
        <AddButtons entity={entity} catalog={catalog}
          onAdd={c => onChange({ ...condition, conditions: [...condition.conditions, c] })} />
      </div>
    </div>
  );
}

// "+ condition", "+ related condition" and "+ any/all group" — enough to build
// every definition the model can produce, by hand.
function AddButtons({ entity, catalog, onAdd, allowRelation = true, allowGroup = false, allowCompare = true }) {
  const relations = catalog.entities[entity].relations;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <button type="button" className={LINK_BUTTON} onClick={() => onAdd(newFieldCondition(catalog, entity))}>+ condition</button>
      {allowRelation && relations.length > 0 && (
        <select aria-label="Add related condition" className={`${INPUT} text-blue-700 dark:text-blue-300`} value=""
          onChange={e => e.target.value && onAdd({ type: 'relation', relation: e.target.value, quantifier: 'some', match: 'all', conditions: [] })}>
          <option value="">+ related condition…</option>
          {relations.map(r => <option key={r.name} value={r.name}>{r.label}</option>)}
        </select>
      )}
      {allowCompare && catalog.entities[entity].compareRelations?.length > 0 && (
        <button type="button" className={LINK_BUTTON} onClick={() => onAdd(newCompareCondition(catalog, entity))}>
          + compare with…
        </button>
      )}
      {allowGroup && (
        <button type="button" className={LINK_BUTTON}
          onClick={() => onAdd({ type: 'group', match: 'any', conditions: [newFieldCondition(catalog, entity)] })}>
          + any/all group
        </button>
      )}
    </div>
  );
}

export default function SpecEditor({ spec, catalog, onChange }) {
  const entity = catalog.entities[spec.entity];
  const toggleColumn = (key) => {
    const has = spec.columns.includes(key);
    onChange({ ...spec, columns: has ? spec.columns.filter(c => c !== key) : [...spec.columns, key] });
  };
  const hasCompare = spec.conditions.some(c => c.type === 'compare' || (c.type === 'group' && c.conditions.some(ic => ic.type === 'compare')));
  const pickable = entity.columns.filter(c => !c.key.startsWith('compare.') || hasCompare);
  const discoveredColumns = pickable.filter(c => c.discovered);
  // Comparison columns describe one row against one reference, so there is nothing
  // to count per value: the API rejects the combination, and it is not offered.
  const groupable = hasCompare ? [] : (entity.groupableFields || []);
  // A sort belongs to the shape of the report: sorting on a field is meaningless
  // once the rows are values with counts, and sorting on the count is meaningless
  // once they are records again. Either way it starts over.
  const setGroupBy = (name) => onChange({ ...spec, groupBy: name || undefined, sort: undefined });

  const changeEntity = (name) => {
    onChange({ entity: name, match: 'all', conditions: [], columns: [...catalog.entities[name].defaultColumns] });
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
          <label htmlFor="spec-entity" className="sr-only">Report on</label>
          <select id="spec-entity" className={`${INPUT} font-semibold`} value={spec.entity} onChange={e => changeEntity(e.target.value)}
            title="Changing this clears the conditions">
            {Object.entries(catalog.entities).map(([n, e]) => <option key={n} value={n}>{e.label}s</option>)}
          </select>
          {spec.conditions.length > 1 && (
            <><span>matching</span><MatchSelect label="Match" value={spec.match} onChange={m => onChange({ ...spec, match: m })} /><span>of:</span></>
          )}
          {spec.conditions.length === 1 && <span>where</span>}
        </div>
        <ConditionList entity={spec.entity} conditions={spec.conditions} catalog={catalog} depth={0}
          onChange={cs => onChange({ ...spec, conditions: cs })} />
        <AddButtons entity={spec.entity} catalog={catalog} allowGroup
          onAdd={c => onChange({ ...spec, conditions: [...spec.conditions, c] })} />
      </div>

      {groupable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
          <label htmlFor="spec-group-by">Count per</label>
          <select id="spec-group-by" className={INPUT} value={spec.groupBy || ''} onChange={e => setGroupBy(e.target.value)}>
            <option value="">nothing — list every {entity.label.toLowerCase()}</option>
            <FieldOptions fields={groupable} />
          </select>
        </div>
      )}

      {spec.groupBy ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          One row per distinct value, with the number of {entity.label.toLowerCase()}s that have it. Columns do not apply.
        </p>
      ) : (
        <fieldset>
          <legend className="mb-1 text-sm font-semibold text-gray-800 dark:text-gray-200">Columns</legend>
          <div className="flex flex-wrap gap-1.5">
            {pickable.filter(c => !c.discovered).map(c => <ColumnChip key={c.key} column={c} spec={spec} onToggle={toggleColumn} />)}
          </div>
          {discoveredColumns.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-gray-600 dark:text-gray-400">
                Attributes from your data ({discoveredColumns.length})
              </summary>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {discoveredColumns.map(c => <ColumnChip key={c.key} column={c} spec={spec} onToggle={toggleColumn} />)}
              </div>
            </details>
          )}
        </fieldset>
      )}
    </div>
  );
}

function ColumnChip({ column, spec, onToggle }) {
  const on = spec.columns.includes(column.key);
  return (
    <button type="button" aria-pressed={on} onClick={() => onToggle(column.key)}
      className={on
        ? 'rounded-full border border-blue-600 bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-800 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-200'
        : 'rounded-full border border-gray-300 px-2.5 py-0.5 text-xs text-gray-700 hover:border-blue-400 dark:border-gray-600 dark:text-gray-300'}>
      {column.label}
    </button>
  );
}

