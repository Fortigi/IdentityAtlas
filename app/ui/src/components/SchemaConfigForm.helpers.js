// Pure helpers for SchemaConfigForm.jsx, kept out of the component file so React Fast
// Refresh can hot-swap it (react-refresh/only-export-components).

/**
 * The form values a lookup said it depends on (`x-lookupDependsOn`), picked out
 * of the whole form so the lookup sees those and nothing else.
 */
export function lookupDependencies(prop, params) {
  const keys = Array.isArray(prop?.['x-lookupDependsOn']) ? prop['x-lookupDependsOn'] : [];
  return Object.fromEntries(keys.map(key => [key, params?.[key]]));
}
