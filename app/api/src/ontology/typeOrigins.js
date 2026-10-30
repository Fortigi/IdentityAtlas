// Where a type value comes from, as the ontology records it — shared by the
// reference page and the type diagrams so the two always say the same thing.
//
//   plugin   — a context-algorithm plugin emits it (ia:producedBy)
//   crawler  — a crawler writes it (ia:emittedBy, from the manifests' emits)
//   code     — the application itself creates it (a context type the code
//              compares against, such as Tag)
//   accepted — defined and accepted from any source, but nothing built in
//              writes it (WorkloadIdentity, SharedMailbox)

import { isSubClassOf } from './model.js';

/** The template a type falls under: the nearest ancestor-or-self with ia:template, or null. */
export function templateOf(model, cls) {
  let cur = cls;
  const seen = new Set();
  while (cur && !seen.has(cur.local)) {
    if (cur.template) return cur;
    seen.add(cur.local);
    cur = model.classes.get(cur.superClasses[0]);
  }
  return null;
}

export const ORIGIN_LABELS = {
  plugin: 'Made by a context plugin',
  crawler: 'Written by a crawler',
  code: 'Created by the application',
  accepted: 'Accepted, no built-in source',
};

/** { group, plugins, crawlers } for one typed class. A plugin wins over a crawler for the group. */
export function typeOrigin(model, cls) {
  const plugins = cls.producedBy;
  const crawlers = cls.emittedBy;
  let group = 'accepted';
  if (plugins.length) group = 'plugin';
  else if (crawlers.length) group = 'crawler';
  else if (isSubClassOf(model, cls.local, 'Context')) group = 'code';
  return { group, plugins, crawlers };
}

/** "plugin `x`, crawlers `a`, `b`" style text for a reference-table cell. */
export function originText(model, cls, code) {
  const { group, plugins, crawlers } = typeOrigin(model, cls);
  const parts = [];
  if (plugins.length) parts.push(`plugin ${plugins.map(code).join(', ')}`);
  if (crawlers.length) parts.push(`${crawlers.length > 1 ? 'crawlers' : 'crawler'} ${crawlers.map(code).join(', ')}`);
  if (parts.length) return parts.join('; ');
  return group === 'code' ? 'application code' : 'no built-in source';
}
