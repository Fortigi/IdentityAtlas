// PROTOTYPE — editor row for a "compare with a reference" condition.
//
// Reads as a sentence: has [exactly the same] [members] as [resource] "[name]".
// The name box suggests matching records from GET /api/nl-reports/lookup; typing
// a new name drops the previously resolved id, so the server resolves it again.

import { useId } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';

const INPUT = 'rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';

/** Entities that have the same relation reaching the same table — valid references. */
export function referenceEntities(catalog, entity, relation) {
  const rel = catalog.entities[entity].relations.find(r => r.name === relation);
  if (!rel) return [];
  const targetTable = catalog.entities[rel.target].table;
  return Object.entries(catalog.entities)
    .filter(([, e]) => e.relations.some(r => r.name === relation && catalog.entities[r.target].table === targetTable))
    .map(([name]) => name);
}

export function newCompareCondition(catalog, entity) {
  const relation = catalog.entities[entity].compareRelations[0];
  const refEntity = referenceEntities(catalog, entity, relation)[0] || entity;
  return { type: 'compare', relation, measure: 'identical', reference: { entity: refEntity, name: '' } };
}

export default function CompareCondition({ entity, condition, catalog, onChange, onRemove, RemoveButton }) {
  const { authFetch } = useAuth();
  const listId = useId();
  const { reference } = condition;
  const relations = catalog.entities[entity].compareRelations;
  const refEntities = referenceEntities(catalog, entity, condition.relation);
  const q = (reference.name || '').trim();

  const { data: suggestions } = useFetch(
    q.length >= 2 ? `/api/nl-reports/lookup?entity=${encodeURIComponent(reference.entity)}&q=${encodeURIComponent(q)}` : null,
    { authFetch, enabled: q.length >= 2, initialData: [], transform: d => d.data || [] },
  );

  const setReference = (patch) => {
    const next = { ...reference, ...patch };
    delete next.id; // any edit means the name must be resolved again
    delete next.type;
    onChange({ ...condition, reference: next });
  };

  const setRelation = (relation) => {
    const valid = referenceEntities(catalog, entity, relation);
    const refEntity = valid.includes(reference.entity) ? reference.entity : valid[0];
    onChange({ ...condition, relation, reference: { entity: refEntity, name: reference.name } });
  };

  const setMeasure = (measure) => {
    const next = { ...condition, measure };
    if (measure === 'similar') next.minSimilarity = condition.minSimilarity ?? 80;
    else delete next.minSimilarity;
    onChange(next);
  };

  const relLabel = (name) => catalog.entities[entity].relations.find(r => r.name === name)?.label || name;

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
      <span>has</span>
      <select aria-label="Comparison" className={INPUT} value={condition.measure} onChange={e => setMeasure(e.target.value)}>
        {Object.entries(catalog.compareMeasures).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
      {condition.measure === 'similar' && (
        <input aria-label="Minimum similarity percentage" type="number" min="1" max="100" className={`${INPUT} w-20`}
          value={condition.minSimilarity ?? 80} onChange={e => onChange({ ...condition, minSimilarity: Number(e.target.value) })} />
      )}
      <select aria-label="Compared relation" className={INPUT} value={condition.relation} onChange={e => setRelation(e.target.value)}>
        {relations.map(r => <option key={r} value={r}>{relLabel(r)}</option>)}
      </select>
      <span>as</span>
      <select aria-label="Reference type" className={INPUT} value={reference.entity} onChange={e => setReference({ entity: e.target.value })}>
        {refEntities.map(n => <option key={n} value={n}>{catalog.entities[n].label.toLowerCase()}</option>)}
      </select>
      <input aria-label="Reference name" list={listId} className={`${INPUT} w-64`} value={reference.name}
        placeholder="name, e.g. Fortigi - Algemeen - Maten" onChange={e => setReference({ name: e.target.value })} />
      <datalist id={listId}>
        {suggestions.map(s => <option key={s.id} value={s.name}>{s.type}</option>)}
      </datalist>
      {reference.id && <span className="text-xs text-green-700 dark:text-green-300" title={reference.type}>✓ found</span>}
      <RemoveButton onRemove={onRemove} />
    </div>
  );
}
