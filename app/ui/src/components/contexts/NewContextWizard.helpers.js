// Pure helpers for the "New context tree" wizard — step config, plugin data
// shaping, and footer labels. Kept out of the component so the orchestrator
// stays thin and these branches are unit-testable in isolation.

// Steps shown in the indicator, by chosen source.
export function stepsFor(source) {
  if (source === 'plugin') return [
    { n: 1, label: 'Source' }, { n: 2, label: 'Pick a rule' },
    { n: 3, label: 'Configure' }, { n: 4, label: 'Preview & run' },
  ];
  if (source === 'manual') return [
    { n: 1, label: 'Source' }, { n: 2, label: 'Details' },
  ];
  if (source === 'upload') return [
    { n: 1, label: 'Source' }, { n: 2, label: 'File' },
    { n: 3, label: 'Mapping' }, { n: 4, label: 'Preview & import' },
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

const isAttributeSource = (spec) => spec['x-attributeSource'] === 'principal';
const isUuidList = (spec) => spec.type === 'array' && (spec.items?.format === 'uuid' || spec['x-picker'] === 'principal');

// Which field the parameter form draws for one schema property. Checked in
// order: the system picker, a dropdown of the allowed values (`enum`), the
// attribute pickers, the person picker for a list of ids, then by type.
export function schemaFieldKind(name, spec = {}) {
  if (name === 'scopeSystemId') return 'system';
  if (Array.isArray(spec.enum)) return 'enum';
  if (spec.type === 'integer' || spec.type === 'number') return 'number';
  if (spec.type === 'boolean') return 'boolean';
  if (isAttributeSource(spec)) return spec.type === 'array' ? 'attributeList' : 'attribute';
  if (isUuidList(spec)) return 'principalList';
  if (spec.type === 'array' || spec.type === 'object') return 'json';
  return 'text';
}

// The choices of an `enum` parameter as { value, label }: the label from
// "x-enumLabels" (a { value: label } map, or an array in the enum's order),
// else the value made readable ("jobTitle" → "Job Title").
export function enumOptions(spec = {}) {
  const labels = spec['x-enumLabels'];
  return (spec.enum || []).map((value, i) => {
    const given = Array.isArray(labels) ? labels[i] : labels?.[value];
    return { value, label: given || prettifyName(String(value)) };
  });
}

// Modal subtitle text for the current source / selection.
export function wizardSubtitle(source, selected) {
  if (!source) return 'Where should this come from?';
  if (source === 'plugin') return selected ? selected.displayName : 'Build a tree from existing data';
  if (source === 'manual') return 'Start an empty tree you’ll curate yourself';
  if (source === 'describe') return 'Build a tree from search terms, in its own tab';
  if (source === 'upload') return 'Your own list of organisation units or applications';
  return 'Import from a system';
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
  if (step === 1 && source === 'import') return 'Open Crawlers →';
  if (step === 1 && source === 'describe') return 'Open the context builder →';
  return 'Next ▸';
}
