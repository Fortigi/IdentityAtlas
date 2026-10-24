// Pure helpers for CompareCondition.jsx, kept out of the component file so React Fast
// Refresh can hot-swap it (react-refresh/only-export-components).

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
