// Templates, and the one rule about holding.
//
// A template (ia:template true) is the level the application reasons at: a
// class between a kind of node (Principal, Resource, Context) and the type
// values the sources use. The checks:
//   - every type (a class with ia:typeValue under a kind) has exactly one
//     template among its ancestors or is one itself, so each type is handled
//     one way; a template sits directly under a kind, or under another template
//     (a sub-kind such as ia:AccessPermission is not itself a template);
//   - ia:expandsAccess agrees with the effective-access engine: the types that
//     inherit true are exactly GROUP_RESOURCE_TYPES, the types that inherit
//     false exactly OWNERSHIP_RESOURCE_TYPES (holding them is never membership);
//   - each ia:ControlPermission type is the range of exactly one relationship
//     type, so "owner and member refer to the same object" is a stated fact;
//   - an ia:accountabilityDefault sits on a principal type and names an
//     ia:Accountability value;
//   - holding stays closed: among the edge classes, ia:ResourceAssignment is the
//     only one from an account or a person to a resource. Anything else would be
//     a second way of holding, outside assignmentType's three values.

import { isSubClassOf, relationshipTypesOf, tableClasses, typedSubclasses } from '../model.js';

const err = (code, subject, message) => ({ code, subject, message });
const KINDS = ['Principal', 'Resource', 'Context'];

function ancestors(model, local, acc = []) {
  const cls = model.classes.get(local);
  if (!cls) return acc;
  for (const s of cls.superClasses) { acc.push(s); ancestors(model, s, acc); }
  return acc;
}

const templatesOf = (model, cls) => [cls.local, ...ancestors(model, cls.local)].filter(l => model.classes.get(l)?.template);

function checkTemplateTree(model) {
  const out = [];
  for (const c of model.classes.values()) {
    if (!c.template) continue;
    const kind = KINDS.find(k => isSubClassOf(model, c.local, k));
    if (!kind) out.push(err('template-misplaced', `ia:${c.local}`, 'a template must be a subclass of ia:Principal, ia:Resource or ia:Context'));
  }
  for (const kind of KINDS) {
    for (const t of typedSubclasses(model, kind)) {
      const found = templatesOf(model, t);
      if (found.length === 0) out.push(err('template-missing', `ia:${t.local}`, `type "${t.typeValue}" has no template among its ancestors (ia:template true) and is not one itself`));
      if (found.length > 1) out.push(err('template-ambiguous', `ia:${t.local}`, `type "${t.typeValue}" is under ${found.length} templates: ${found.map(x => `ia:${x}`).join(', ')}`));
    }
  }
  return out;
}

// The nearest ia:expandsAccess on the type or an ancestor, or undefined.
function inheritedExpandsAccess(model, cls) {
  for (const l of [cls.local, ...ancestors(model, cls.local)]) {
    const v = model.classes.get(l)?.expandsAccess;
    if (v !== undefined) return v === 'true';
  }
  return undefined;
}

function setDiff(expected, actual) {
  const a = new Set(actual), e = new Set(expected);
  return { missing: [...e].filter(v => !a.has(v)), extra: [...a].filter(v => !e.has(v)) };
}

function checkExpandsAccess(model, registry) {
  const groups = registry.access?.expands;
  const owners = registry.access?.never;
  if (!groups || !owners) return [];
  const types = typedSubclasses(model, 'Resource');
  const expands = types.filter(t => inheritedExpandsAccess(model, t) === true).map(t => t.typeValue);
  const never = types.filter(t => inheritedExpandsAccess(model, t) === false).map(t => t.typeValue);
  const out = [];
  const g = setDiff(groups, expands);
  for (const v of g.missing) out.push(err('expands-access-mismatch', `Resource:${v}`, `the effective-access engine expands "${v}" (GROUP_RESOURCE_TYPES) but the ontology does not mark it ia:expandsAccess true`));
  for (const v of g.extra) out.push(err('expands-access-mismatch', `Resource:${v}`, `the ontology marks "${v}" ia:expandsAccess true but the effective-access engine does not expand it`));
  const o = setDiff(owners, never);
  for (const v of o.missing) out.push(err('expands-access-mismatch', `Resource:${v}`, `lib/ownershipTypes.js excludes "${v}" from access but the ontology does not mark it ia:expandsAccess false`));
  for (const v of o.extra) out.push(err('expands-access-mismatch', `Resource:${v}`, `the ontology marks "${v}" ia:expandsAccess false but lib/ownershipTypes.js does not exclude it`));
  return out;
}

function checkControlLinks(model) {
  const out = [];
  // Only relationships whose whole range is control permissions count: Contains
  // or GrantsAccessTo may reach any resource and say nothing about control.
  const rels = tableClasses(model).filter(c => c.typeColumn).flatMap(e => relationshipTypesOf(model, e.local))
    .filter(r => r.rangeClasses.length > 0 && r.rangeClasses.every(rc => isSubClassOf(model, rc, 'ControlPermission')));
  for (const t of typedSubclasses(model, 'ControlPermission')) {
    const pointing = rels.filter(r => r.rangeClasses.some(rc => isSubClassOf(model, t.local, rc)));
    if (pointing.length !== 1) {
      out.push(err('control-permission-link', `ia:${t.local}`, `a control permission must be the range of exactly one relationship type (the link from what it controls); "${t.typeValue}" is the range of ${pointing.length ? pointing.map(r => `ia:${r.local}`).join(', ') : 'none'}`));
    }
  }
  return out;
}

function checkAccountabilityDefaults(model) {
  const out = [];
  for (const c of model.classes.values()) {
    if (!c.accountabilityDefault) continue;
    const s = `ia:${c.local}`;
    if (!c.typeValue || !isSubClassOf(model, c.local, 'Principal')) out.push(err('accountability-default-misplaced', s, 'ia:accountabilityDefault belongs on a principal type'));
    if (!model.individuals.get(c.accountabilityDefault)?.types.includes('Accountability')) out.push(err('accountability-default-invalid', s, `ia:accountabilityDefault ia:${c.accountabilityDefault} is not an ia:Accountability value`));
  }
  return out;
}

const HOLDERS = ['Principal', 'Identity'];

function checkHoldingClosed(model) {
  const out = [];
  const ranges = (props) => props.flatMap(p => model.properties.get(p)?.rangeClasses ?? []);
  for (const e of tableClasses(model).filter(c => isSubClassOf(model, c.local, 'Edge'))) {
    const fromHolder = ranges(e.sourceProperties).some(r => HOLDERS.some(h => isSubClassOf(model, r, h)));
    const toResource = ranges(e.targetProperties).some(r => isSubClassOf(model, r, 'Resource'));
    if (fromHolder && toResource && e.local !== 'ResourceAssignment') {
      out.push(err('holding-bypass', `ia:${e.local}`, 'an account or a person reaches a resource only through ia:ResourceAssignment (Direct, Indirect, Eligible); this edge would be a second way of holding'));
    }
  }
  return out;
}

/** Template and holding rules. Model-only parts run without a registry. */
export function checkTemplates(model, registry = {}) {
  return [
    ...checkTemplateTree(model),
    ...checkExpandsAccess(model, registry),
    ...checkControlLinks(model),
    ...checkAccountabilityDefaults(model),
    ...checkHoldingClosed(model),
  ];
}
