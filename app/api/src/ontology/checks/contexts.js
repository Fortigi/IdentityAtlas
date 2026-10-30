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
//   - the stored template values (ia:ContextCategory) name exactly the templates
//     under ia:Context, and a plugin's contextCategory is one of them with every
//     type it emits beneath it;
//   - each defined context type is produced by a plugin, written by a crawler
//     (ia:emittedBy, checked in ./crawlers.js) or compared against —
//     the ontology does not collect values nothing in the code knows about.

import { isSubClassOf, schemeMembers, typedSubclasses } from '../model.js';

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

// The stored template value (ia:ContextCategory) names exactly the templates
// under ia:Context, one each, in both directions.
function checkCategoryScheme(model) {
  const members = schemeMembers(model, 'ContextCategory');
  if (!members.length) return [];
  const templates = [...model.classes.values()].filter(c => c.template && c.local !== 'Context' && isSubClassOf(model, c.local, 'Context')).map(c => c.local);
  const out = [];
  const denoted = [];
  for (const m of members) {
    if (!m.denotesTemplate || !templates.includes(m.denotesTemplate)) out.push(err('context-category-template', `ia:${m.local}`, `ia:denotesTemplate ${m.denotesTemplate ? `ia:${m.denotesTemplate}` : 'is missing and'} must name a template under ia:Context`));
    else denoted.push(m.denotesTemplate);
  }
  for (const t of templates.filter(t => !denoted.includes(t))) out.push(err('context-category-template', `ia:${t}`, 'is a template under ia:Context but no ia:ContextCategory value denotes it'));
  for (const d of denoted.filter((t, i) => denoted.indexOf(t) !== i)) out.push(err('context-category-template', `ia:${d}`, 'is denoted by two ia:ContextCategory values'));
  return out;
}

// The template a plugin declares exists, and every type it emits sits under it.
function templateFor(model, value) {
  const byValue = schemeMembers(model, 'ContextCategory').find(m => m.typeValue === value)?.denotesTemplate;
  const local = byValue ?? value;
  const cls = model.classes.get(local);
  return cls?.template && isSubClassOf(model, local, 'Context') ? cls : null;
}

function checkPluginCategories(model, byType, plugins) {
  const out = [];
  for (const p of plugins) {
    if (p.contextCategory === undefined) continue;
    const tpl = templateFor(model, p.contextCategory);
    if (!tpl) { out.push(err('plugin-category-undefined', `plugin:${p.name}`, `declares contextCategory "${p.contextCategory}", which is not a template under ia:Context`)); continue; }
    for (const value of p.contextTypes ?? []) {
      const cls = byType.get(value);
      if (cls && !isSubClassOf(model, cls.local, tpl.local)) out.push(err('plugin-category-mismatch', `plugin:${p.name}`, `emits "${value}" (ia:${cls.local}), which is not under its template ia:${tpl.local}`));
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
    ...checkCategoryScheme(model),
    ...checkPluginCategories(model, byValue, plugins),
  ];
}
