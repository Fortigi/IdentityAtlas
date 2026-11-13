// Example instance data written in the core ontology (ontology/examples/*.ttl).
//
// An example is a handful of concrete rows — an account, a group, an
// assignment, a team — expressed as RDF with the ontology's own terms. It is
// what the model looks like with data in it, and the docs draw a picture of it.
// Because a hand-written example drifts as easily as a hand-drawn diagram, the
// check validates it against the ontology and the picture is generated:
//   - every resource has exactly one rdf:type, a concrete core class;
//   - every property is a core property whose domain admits the resource;
//   - every reference points at a resource of the example whose class fits the
//     property's range; a relationship type connects classes it allows;
//   - a value from a closed list is one of that list's values, and a context's
//     targetType is one its context type allows;
//   - an edge row (assignment, membership) names both of its ends.

import { TYPE, localName } from './vocabulary.js';
import { isSubClassOf, schemeMembers } from './model.js';
import { NODE_STYLE } from './mermaid.js';

const err = (code, subject, message) => ({ code, subject, message });
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const short = (iri) => iri.replace(/^.*[#/]/, '');

/**
 * Flatten a parsed example store into instances:
 * Map<iri, { iri, id, types: [local], values: Map<propertyLocal, [{ iri?, literal? }]> }>.
 * Predicates outside the ia: namespace (other than rdf:type) are kept under their full IRI.
 */
export function readInstances(store) {
  const out = new Map();
  for (const q of store.getQuads(null, null, null, null)) {
    if (q.subject.termType !== 'NamedNode') continue;
    const s = q.subject.value;
    if (!out.has(s)) out.set(s, { iri: s, id: short(s), types: [], values: new Map() });
    const inst = out.get(s);
    if (q.predicate.value === TYPE) { inst.types.push(localName(q.object.value) ?? q.object.value); continue; }
    const p = localName(q.predicate.value) ?? q.predicate.value;
    if (!inst.values.has(p)) inst.values.set(p, []);
    inst.values.get(p).push(q.object.termType === 'NamedNode' ? { iri: q.object.value } : { literal: q.object.value });
  }
  return out;
}

const classOf = (instances, iri) => instances.get(iri)?.types[0];

function checkType(model, inst) {
  const s = `example:${inst.id}`;
  if (inst.types.length !== 1) return [err('example-type', s, `needs exactly one rdf:type, has ${inst.types.length}`)];
  const cls = model.classes.get(inst.types[0]);
  if (!cls) return [err('example-type', s, `rdf:type ${inst.types[0]} is not a core class`)];
  const concrete = isSubClassOf(model, cls.local, 'Node') || isSubClassOf(model, cls.local, 'Edge');
  if (!concrete || cls.local === 'Node' || cls.local === 'Edge') return [err('example-type', s, `ia:${cls.local} is not a node or edge class`)];
  return [];
}

function checkReference(model, instances, s, prop, value) {
  if (!value.iri) return [err('example-range', s, `ia:${prop.local} needs a reference, not a literal`)];
  const target = classOf(instances, value.iri);
  if (!target) return [err('example-dangling', s, `ia:${prop.local} points at ${short(value.iri)}, which is not in the example`)];
  if (!prop.rangeClasses.some(r => isSubClassOf(model, target, r))) {
    return [err('example-range', s, `ia:${prop.local} expects ${prop.rangeClasses.map(r => `ia:${r}`).join(' | ')}, ${short(value.iri)} is ia:${target}`)];
  }
  return [];
}

function checkLiteral(model, s, prop, value) {
  if (value.iri) return [err('example-range', s, `ia:${prop.local} is a value, not a reference`)];
  if (!prop.valueScheme) return [];
  const allowed = schemeMembers(model, prop.valueScheme).map(i => i.typeValue);
  return allowed.includes(value.literal) ? [] : [err('example-value', s, `ia:${prop.local} "${value.literal}" is not one of ${allowed.join(', ')}`)];
}

function checkProperty(model, instances, inst, name, values) {
  const s = `example:${inst.id}`;
  if (name === RDFS_LABEL) return [];
  const prop = model.properties.get(name);
  if (!prop) return [err('example-property', s, `${name} is not a core property`)];
  const cls = inst.types[0];
  if (!prop.domains.some(d => isSubClassOf(model, cls, d))) {
    return [err('example-domain', s, `ia:${name} does not apply to ia:${cls} (domain ${prop.domains.map(d => `ia:${d}`).join(' | ')})`)];
  }
  if (prop.storedIn && !prop.sqlType) {
    // A relationship-type shortcut: it needs a reference, like a foreign key.
    return values.flatMap(v => checkReference(model, instances, s, prop, v));
  }
  return values.flatMap(v => (prop.kind === 'object' ? checkReference(model, instances, s, prop, v) : checkLiteral(model, s, prop, v)));
}

function checkContextTarget(model, inst) {
  const cls = model.classes.get(inst.types[0]);
  if (!cls?.allowedTargetTypes.length) return [];
  const allowed = cls.allowedTargetTypes.map(i => model.individuals.get(i)?.typeValue);
  return (inst.values.get('targetType') ?? [])
    .filter(v => !allowed.includes(v.literal))
    .map(v => err('example-target-type', `example:${inst.id}`, `a ${cls.typeValue} context groups ${allowed.join(', ')}, not ${v.literal}`));
}

function checkEdgeEnds(model, inst) {
  const cls = model.classes.get(inst.types[0]);
  if (!cls || !isSubClassOf(model, cls.local, 'Edge')) return [];
  const has = (props) => props.some(p => inst.values.has(p));
  return has(cls.sourceProperties) && has(cls.targetProperties)
    ? []
    : [err('example-edge-ends', `example:${inst.id}`, `an ia:${cls.local} row needs ${cls.sourceProperties.join(' or ')} and ${cls.targetProperties.join(' or ')}`)];
}

/** Validate example instances against the model. Returns findings. */
export function checkExample(model, instances, source = 'example') {
  if (instances.size === 0) return [err('example-empty', source, 'the example has no resources')];
  const out = [];
  for (const inst of instances.values()) {
    const typeErrors = checkType(model, inst);
    out.push(...typeErrors);
    if (typeErrors.length) continue;
    for (const [name, values] of inst.values) out.push(...checkProperty(model, instances, inst, name, values));
    out.push(...checkContextTarget(model, inst), ...checkEdgeEnds(model, inst));
  }
  return out;
}

// ─── Picture ────────────────────────────────────────────────────────────────

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const label = (s) => String(s).replace(/"/g, '#quot;');
const first = (inst, p) => inst.values.get(p)?.[0];

function kindOf(model, cls) {
  return Object.keys(NODE_STYLE).find(k => isSubClassOf(model, cls, k));
}

function nodeLine(model, inst) {
  const cls = model.classes.get(inst.types[0]);
  const name = first(inst, 'displayName')?.literal ?? inst.id;
  return `    ${inst.id}["${label(name)}<br/><small>${label(cls.label)}</small>"]:::${kindOf(model, cls.local)}`;
}

// An edge row becomes one arrow from its source to its target.
function edgeArrow(model, inst) {
  const cls = model.classes.get(inst.types[0]);
  const end = (props) => props.map(p => first(inst, p)?.iri).find(Boolean);
  const from = end(cls.sourceProperties);
  const to = end(cls.targetProperties);
  const how = first(inst, 'assignmentType')?.literal ?? first(inst, 'role')?.literal;
  const governed = first(inst, 'governed')?.literal === 'true' ? ', governed' : '';
  const text = how ? `${how}${governed}` : cls.label.toLowerCase();
  return `    ${short(from)} -->|"${label(text)}"| ${short(to)}`;
}

// The system an instance comes from, when the example contains that system.
// Drawn as a box around its accounts and resources instead of one arrow each.
const SYSTEM_PROPERTY = 'systemId';
function systemOf(instances, inst) {
  const iri = first(inst, SYSTEM_PROPERTY)?.iri;
  return iri && instances.has(iri) ? iri : null;
}

// References between nodes: a relationship type is a solid arrow, a plain
// foreign key (manager, parent) a dotted one.
function referenceArrows(model, instances, inst) {
  const out = [];
  for (const [name, values] of [...inst.values].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const prop = model.properties.get(name);
    if (!prop || prop.kind !== 'object' || (name === SYSTEM_PROPERTY && systemOf(instances, inst))) continue;
    for (const v of values.filter(x => x.iri && instances.has(x.iri))) {
      out.push(prop.storedIn && !prop.sqlType
        ? `    ${inst.id} ==>|"${label(prop.typeValue)}"| ${short(v.iri)}`
        : `    ${inst.id} -.->|"${label(name)}"| ${short(v.iri)}`);
    }
  }
  return out;
}

// A system with members becomes a subgraph holding them; one without stays a node.
function nodeLines(model, instances, nodes) {
  const inSystem = new Map();
  for (const n of nodes) {
    const sys = systemOf(instances, n);
    if (sys) inSystem.set(sys, [...(inSystem.get(sys) ?? []), n]);
  }
  const lines = [];
  for (const n of nodes) {
    if (systemOf(instances, n)) continue;
    const members = inSystem.get(n.iri);
    if (!members) { lines.push(nodeLine(model, n)); continue; }
    const name = first(n, 'displayName')?.literal ?? n.id;
    lines.push(`    subgraph ${n.id}["${label(name)} · ${label(model.classes.get(n.types[0]).label)}"]`);
    lines.push(...members.map(m => `  ${nodeLine(model, m)}`), '    end');
  }
  return lines;
}

/** Mermaid flowchart of an example. Deterministic: sorted by resource id. */
export function exampleDiagram(model, instances) {
  const all = [...instances.values()].sort(byId);
  const isEdge = (i) => isSubClassOf(model, i.types[0], 'Edge');
  const nodes = all.filter(i => !isEdge(i));
  const lines = ['flowchart LR'];
  lines.push(...nodeLines(model, instances, nodes));
  lines.push(...all.filter(isEdge).map(i => edgeArrow(model, i)));
  lines.push(...nodes.flatMap(i => referenceArrows(model, instances, i)));
  for (const [kind, style] of Object.entries(NODE_STYLE)) lines.push(`    classDef ${kind} ${style}`);
  return lines.join('\n');
}

