// Pure helpers for EntityLookup.jsx, kept out of the component file so React Fast
// Refresh can hot-swap it (react-refresh/only-export-components).

/**
 * `&contexts=a,b` for the form values a source said it depends on, so its
 * options can follow an earlier choice. Empty values are left out; the order is
 * the caller's, so the string is stable for an unchanged form.
 */
export function dependencyQuery(dependsOn) {
  return Object.entries(dependsOn || {})
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value ?? '')])
    .filter(([, value]) => value)
    .map(([key, value]) => `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('');
}

/**
 * Options whose labels collide inside ONE result list, with the head of their
 * id appended to the hint. A catalogue with three applications under one name
 * is exactly the case this control exists for, so it must not offer three rows
 * a person cannot tell apart.
 */
export function disambiguate(options) {
  const seen = new Map();
  for (const option of options) seen.set(option.label, (seen.get(option.label) || 0) + 1);
  return options.map(option => (seen.get(option.label) > 1
    ? { ...option, hint: [option.hint, `id ${String(option.value).slice(0, 8)}`].filter(Boolean).join(' · ') }
    : option));
}
