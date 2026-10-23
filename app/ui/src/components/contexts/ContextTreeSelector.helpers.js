// Pure helpers for ContextTreeSelector — kept out of the component file (the
// react-refresh fast-refresh rule) so they can be unit-tested directly. Where a
// tree comes from is said by the source group headings (treePanel.helpers).

// The systems the roots are scoped to, as [id, name] pairs sorted by name —
// the options of the system filter.
export function scopeSystems(roots) {
  const seen = new Map();
  for (const r of roots || []) {
    if (r.scopeSystemId && r.scopeSystemName && !seen.has(r.scopeSystemId)) seen.set(r.scopeSystemId, r.scopeSystemName);
  }
  return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
}

// The roots passing the pane's filters; an empty filter lets everything through.
// `target` is the kind of member, `variant` the source (imported / derived /
// created here).
export function filterRoots(roots, { target, variant, system }) {
  return (roots || []).filter(r =>
    (!target  || r.targetType === target) &&
    (!variant || r.variant    === variant) &&
    (!system  || String(r.scopeSystemId) === system));
}
