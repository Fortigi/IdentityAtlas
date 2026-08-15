// Pure helpers for the "New context tree" wizard — step config, plugin data
// shaping, and footer labels. Kept out of the component so the orchestrator
// stays thin and these branches are unit-testable in isolation.

// Steps shown in the indicator, by chosen source.
export function stepsFor(source) {
  if (source === 'plugin') return [
    { n: 1, label: 'Source' }, { n: 2, label: 'Pick plugin' },
    { n: 3, label: 'Configure' }, { n: 4, label: 'Preview & run' },
  ];
  if (source === 'manual') return [
    { n: 1, label: 'Source' }, { n: 2, label: 'Details' },
  ];
  return [{ n: 1, label: 'Source' }];
}

// Group plugins by their targetType, sorted alphabetically for a stable picker.
export function groupByTargetType(plugins) {
  const map = new Map();
  for (const p of plugins) {
    if (!map.has(p.targetType)) map.set(p.targetType, []);
    map.get(p.targetType).push(p);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// "scopeSystemId" -> "Scope System Id" for form labels.
export function prettifyName(name) {
  return name.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
}

// Modal subtitle text for the current source / selection.
export function wizardSubtitle(source, selected) {
  if (!source) return 'Where should this tree come from?';
  if (source === 'plugin') return selected ? selected.displayName : 'Build a tree from existing data';
  if (source === 'manual') return 'Start an empty tree you’ll curate yourself';
  return 'Import from a crawler';
}

// Seed a plugin's params object from its schema defaults.
export function seedParamsFromSchema(selected) {
  const defaults = {};
  const props = selected?.parametersSchema?.properties || {};
  for (const [name, spec] of Object.entries(props)) {
    if (spec?.default !== undefined) defaults[name] = spec.default;
  }
  return defaults;
}

// Required schema params that are still empty (drives the "Missing: …" hint and
// the Next-button gate on the Configure step).
export function pluginMissingParams(selected, params) {
  if (!selected) return [];
  return (selected.parametersSchema?.required || []).filter(n => {
    const v = params[n];
    return v === undefined || v === null || v === '';
  });
}

// Existing generated trees this plugin + system could refresh in place (only
// instance-keyed trees — legacy NULL-key trees aren't offered).
export function computeRefreshTargets(genRoots, selected, scopeSystemIdParam) {
  if (!selected) return [];
  const sys = scopeSystemIdParam !== undefined && scopeSystemIdParam !== ''
    ? parseInt(scopeSystemIdParam, 10) : null;
  return genRoots.filter(r =>
    r.sourceAlgorithmName === selected.name &&
    (sys == null || r.scopeSystemId === sys) &&
    !!r.sourceInstanceKey
  );
}

// ─── Footer button labels / gates ─────────────────────────────────────────────
export function runLabel(running, mode) {
  if (running) return 'Starting…';
  return mode === 'refresh' ? 'Refresh tree' : 'Create tree';
}

export function runDisabled(running, dryRunning, mode, refreshKey) {
  return running || dryRunning || (mode === 'refresh' && !refreshKey);
}

export function nextLabel(step, source) {
  return step === 1 && source === 'import' ? 'Open Crawlers →' : 'Next ▸';
}
