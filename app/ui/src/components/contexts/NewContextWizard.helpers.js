// Pure helpers for the "New context tree" wizard — step config, plugin data
// shaping, and footer labels. Kept out of the component so the orchestrator
// stays thin and these branches are unit-testable in isolation.

// Steps shown in the indicator, by chosen source.
export function stepsFor(source, selected = null) {
  if (source === 'plugin' && isGuidedOrgPlugin(selected)) return [
    { n: 1, label: 'Source' }, { n: 2, label: 'Pick a rule' },
    { n: 3, label: 'People' }, { n: 4, label: 'Managers' }, { n: 5, label: 'Names' },
    { n: 6, label: 'Preview & run' },
  ];
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

// A plugin whose schema asks for the guided organisation steps.
export function isGuidedOrgPlugin(plugin) {
  return plugin?.parametersSchema?.['x-wizard'] === 'org';
}

// Which guided step a wizard step number is, or null.
export function orgStepFor(step, selected) {
  if (!isGuidedOrgPlugin(selected)) return null;
  return { 3: 'people', 4: 'managers', 5: 'names' }[step] || null;
}

const HR_FILTER = Object.freeze({ attribute: 'employeeId', condition: 'isNotNull' });

// Which choice of the "who belongs" question a list of rules is.
export function peoplePreset(filters) {
  if (!Array.isArray(filters) || filters.length === 0) return 'all';
  const [f] = filters;
  return filters.length === 1 && f.attribute === HR_FILTER.attribute && f.condition === HR_FILTER.condition ? 'hr' : 'custom';
}

// The rules a choice starts from. A custom rule starts on another attribute than
// the HR one, so it reads as custom until the analyst has filled it in.
export function presetFilters(preset) {
  if (preset === 'hr') return [{ ...HR_FILTER }];
  if (preset === 'custom') return [{ attribute: '', condition: 'equals', value: '' }];
  return [];
}

// A rule the analyst started but did not finish, which the API would refuse.
export function incompletePeopleRule(filters) {
  return (Array.isArray(filters) ? filters : []).some((f) => {
    if (!f.attribute) return true;
    if (f.condition === 'isNotNull') return false;
    if (f.condition === 'inValues') return !(f.values || []).some(v => v.trim());
    return !String(f.value || '').trim();
  });
}

// The same schema with only the named properties, in that order.
export function pickSchema(schema, names) {
  const props = schema?.properties || {};
  const properties = Object.fromEntries(names.filter(n => props[n]).map(n => [n, props[n]]));
  return { ...schema, properties, required: (schema?.required || []).filter(n => properties[n]) };
}

const ORG_GUIDED_FIELDS = new Set([
  'scopeSystemId', 'peopleFilters', 'excludeSecondAccounts', 'excludeInactive',
  'managerPlacement', 'nameFrom', 'nameFields', 'includeManagerName',
]);

// Everything the guided steps do not ask about.
export function orgMoreOptionsSchema(schema) {
  return pickSchema(schema, Object.keys(schema?.properties || {}).filter(n => !ORG_GUIDED_FIELDS.has(n)));
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

// The first step the wizard may go back to: on an existing tree the source and
// the rule are fixed, so it starts at the rule's settings.
export const firstStepOf = (editing) => (editing ? 3 : 1);

// A settings step may go on once nothing required is missing and the people
// rule, if any, is complete.
export function configStepReady(pluginMissing, params) {
  return pluginMissing.length === 0 && !incompletePeopleRule(params?.peopleFilters);
}

// Opened on an existing tree whose settings have not come in yet.
export const settingsPending = (editTreeKey, selected) => !!editTreeKey && !selected;

// The modal's title and subtitle.
export function wizardTitles(editing, source = null, selected = null) {
  if (editing) return { title: 'Tree settings', subtitle: 'Change how this tree is built' };
  return { title: 'New context tree', subtitle: wizardSubtitle(source, selected) };
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
    // x-wizardDefault: what a new tree starts with here, where the API default
    // stays as it was so existing trees and API callers do not change.
    const seed = spec?.['x-wizardDefault'] !== undefined ? spec['x-wizardDefault'] : spec?.default;
    if (seed !== undefined) defaults[name] = seed;
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

// The settings an existing tree was built with, and the plugin that built it.
export async function fetchTreeSettings(authFetch, treeKey, plugins) {
  const r = await authFetch(`/api/context-plugins/tree-settings/${encodeURIComponent(treeKey)}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  const plugin = plugins.find(p => p.name === body.pluginName);
  if (!plugin) throw new Error('The settings of this tree cannot be changed here.');
  return { plugin, instanceKey: body.instanceKey, params: body.params || {} };
}

// ─── Footer button labels / gates ─────────────────────────────────────────────
export function runLabel(running, mode, editing = false) {
  if (running) return 'Starting…';
  if (editing) return 'Apply to tree';
  return mode === 'refresh' ? 'Refresh tree' : 'Create tree';
}

// Applying to an existing tree needs a preview that kept something: a run that
// produces no units removes the tree's units.
export function runDisabled(running, dryRunning, mode, refreshKey, editing = false, previewCount = 0) {
  return running || dryRunning || (mode === 'refresh' && !refreshKey) || (editing && !previewCount);
}

export function nextLabel(step, source) {
  if (step === 1 && source === 'import') return 'Open Crawlers →';
  if (step === 1 && source === 'describe') return 'Open the context builder →';
  return 'Next ▸';
}
