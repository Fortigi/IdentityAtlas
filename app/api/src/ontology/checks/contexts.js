// Agreement between the ontology's context types and the code that makes and
// reads contexts.
//
// contextType is an open vocabulary — a crawler or an analyst may store any
// string — so this is not a closed-list comparison. What it does pin down is
// every value the APPLICATION gives a meaning to:
//   - each value a context-algorithm plugin declares in `contextTypes` is a
//     subclass of ia:Context whose ia:producedBy names that plugin, and whose
//     ia:allowedTargetType admits the plugin's targetType (a context groups one
//     kind of entity);
//   - each ia:producedBy names a registered plugin that still declares the
//     value (the reverse direction, so a renamed plugin type fails);
//   - each value the code compares against is defined;
//   - each defined context type is produced by a plugin, written by a crawler
//     (ia:emittedBy, checked in ./crawlers.js) or compared against —
//     the ontology does not collect values nothing in the code knows about.

import { typedSubclasses } from '../model.js';

const err = (code, subject, message) => ({ code, subject, message });

function targetTypeValues(model, cls) {
  return cls.allowedTargetTypes.map(i => model.individuals.get(i)?.typeValue).filter(Boolean);
}

function checkPlugin(model, byValue, plugin) {
  const subject = `plugin:${plugin.name}`;
  if (!Array.isArray(plugin.contextTypes) || plugin.contextTypes.length === 0) {
    return [err('plugin-context-types-undeclared', subject, 'declares no contextTypes (see contexts/plugins/types.js)')];
  }
  const out = [];
  for (const value of plugin.contextTypes) {
    const cls = byValue.get(value);
    if (!cls) {
      out.push(err('context-type-undefined', `Context:${value}`, `plugin ${plugin.name} emits "${value}", which is not a subclass of ia:Context in the ontology`));
      continue;
    }
    if (!cls.producedBy.includes(plugin.name)) {
      out.push(err('context-producer-undeclared', `ia:${cls.local}`, `plugin ${plugin.name} emits "${value}" but ia:producedBy does not name it`));
    }
    const allowed = targetTypeValues(model, cls);
    if (!allowed.includes(plugin.targetType)) {
      out.push(err('context-target-type-mismatch', `ia:${cls.local}`, `plugin ${plugin.name} emits it with targetType ${plugin.targetType}, but ia:allowedTargetType admits only ${allowed.join(', ') || 'nothing'}`));
    }
  }
  return out;
}

function checkProducers(byValue, plugins) {
  const byName = new Map(plugins.map(p => [p.name, p]));
  const out = [];
  for (const cls of byValue.values()) {
    for (const name of cls.producedBy) {
      const plugin = byName.get(name);
      if (!plugin) out.push(err('context-producer-unknown', `ia:${cls.local}`, `ia:producedBy "${name}" is not a registered context plugin`));
      else if (!(plugin.contextTypes ?? []).includes(cls.typeValue)) {
        out.push(err('context-producer-stale', `ia:${cls.local}`, `ia:producedBy "${name}", but that plugin no longer declares "${cls.typeValue}"`));
      }
    }
  }
  return out;
}

function checkUsage(byValue, branchedOn) {
  const out = [];
  for (const [value, where] of branchedOn) {
    if (!byValue.has(value)) out.push(err('context-type-undefined', `Context:${value}`, `the code compares against "${value}" (${where.join(', ')}) but it is not a subclass of ia:Context in the ontology`));
  }
  for (const cls of byValue.values()) {
    if (cls.producedBy.length === 0 && cls.emittedBy.length === 0 && !branchedOn.has(cls.typeValue)) {
      out.push(err('context-type-unused', `ia:${cls.local}`, `"${cls.typeValue}" is neither emitted by a plugin or a crawler nor compared against anywhere in the code`));
    }
  }
  return out;
}

/** Context-type agreement. `registry.contexts` = { plugins, branchedOn: Map }. */
export function checkContextTypes(model, registry) {
  if (!registry.contexts) return [];
  const byValue = new Map(typedSubclasses(model, 'Context').map(c => [c.typeValue, c]));
  const { plugins, branchedOn } = registry.contexts;
  return [
    ...plugins.flatMap(p => checkPlugin(model, byValue, p)),
    ...checkProducers(byValue, plugins),
    ...checkUsage(byValue, branchedOn),
  ];
}
