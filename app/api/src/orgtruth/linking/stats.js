// Organisation truth — link statistics without writing anything (owned by
// workstream T2). The dry-run (T1) calls this with the entities a recipe would
// produce, so the wizard's data-quality step can say, per entity type:
// how many match one system object, several, or none.
//
// Contract:
//   linkStats(entities, linkRules) → Promise<{
//     [entityType]: { total, unique, ambiguous, none, samples: { ambiguous: [...], none: [...] } }
//   }>
//
// `entities` is the in-memory shape applyRecipe produces:
//   { entityType, displayName, canonicalKey, attributes: { [name]: value } }
export async function linkStats(entities, linkRules) {
  const out = {};
  for (const rule of linkRules ?? []) {
    const total = entities.filter(e => e.entityType === rule.entityType).length;
    out[rule.entityType] = { total, unique: 0, ambiguous: 0, none: total, samples: { ambiguous: [], none: [] }, notBuilt: true };
  }
  return out;
}
