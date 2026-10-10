// The matrix filter condition on organisation entities (T8) — the pure half of
// the wizard's "+ Organisation" picker and its chip.
//
// The condition, resolved by the API at query time from OrgLinks:
//
//   { kind: 'org',
//     entityType: 'Klant',                          // required
//     entityIds:  ['<uuid>', ...],                   // optional; absent = every entity of the type
//     attribute:  { key: 'iso27001', values: ['Ja'] },// optional; ANDed with entityIds
//     via:        ['eigenaar', 'Uren'],              // optional; absent = every link
//     labels:     { '<uuid>': 'Contoso Bank' } }     // display only, the API ignores it
//
// Kept apart from the .jsx so the decisions here are mutated
// (stryker.orgtruth.config.json): a wrong one silently widens a matrix to every
// entity of a type, or narrows it to links nobody chose.

// How many picked entities the chip names before it says "+N more".
export const CHIP_LABEL_LIMIT = 3;

// The system types an org link may point at that reach each side of the
// matrix: a subject is reached directly, through its person (Identity) or
// through a context it is a member of; a resource directly or through a context.
const SIDE_TARGETS = {
  Principal: ['Principal', 'Identity', 'Context'],
  Identity: ['Principal', 'Identity', 'Context'],
  Resource: ['Resource', 'Context'],
};

// The "linked through" options that can reach `entity` ('Principal' |
// 'Identity' | 'Resource'). A via without a target list is kept: the API did
// not say, so hiding it would hide a real link.
export function viasForSide(vias, entity) {
  const reach = SIDE_TARGETS[entity];
  if (!Array.isArray(vias)) return [];
  if (!reach) return vias;
  return vias.filter(v => !Array.isArray(v?.targets) || v.targets.some(t => reach.includes(t)));
}

function cleanValues(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(v => String(v ?? '').trim()).filter(Boolean))];
}

function attributePart(key, values) {
  const k = String(key ?? '').trim();
  if (!k) return { attribute: null };
  const vals = cleanValues(values);
  if (vals.length === 0) return { problem: `Pick at least one value of ${k}, or clear the attribute.` };
  return { attribute: { key: k, values: vals } };
}

function viaPart(vias, unchecked) {
  const names = (vias || []).map(v => v.name);
  const off = new Set(unchecked || []);
  const kept = names.filter(n => !off.has(n));
  if (names.length > 0 && kept.length === 0) return { problem: 'Tick at least one way of being linked.' };
  // Every option ticked means every link — the API reads an absent `via` that way.
  return { via: kept.length === names.length ? null : kept };
}

// The condition the picker's state describes, or the reason it cannot be added.
//   draft: { entityType, attributeKey, attributeValues, picked: [{id, label}], uncheckedVias }
//   vias:  the via options shown (already narrowed by viasForSide)
// Returns { condition } or { problem }.
export function buildOrgCondition(draft, vias) {
  const entityType = String(draft?.entityType ?? '').trim();
  if (!entityType) return { problem: 'Pick a kind of organisation entity.' };
  const attr = attributePart(draft.attributeKey, draft.attributeValues);
  if (attr.problem) return { problem: attr.problem };
  const via = viaPart(vias, draft.uncheckedVias);
  if (via.problem) return { problem: via.problem };

  const condition = { kind: 'org', entityType };
  const picked = (draft.picked || []).filter(p => p?.id);
  if (picked.length > 0) {
    condition.entityIds = picked.map(p => p.id);
    condition.labels = Object.fromEntries(picked.map(p => [p.id, p.label || p.id]));
  }
  if (attr.attribute) condition.attribute = attr.attribute;
  if (via.via) condition.via = via.via;
  return { condition };
}

// Does the condition select every entity of its type (no ids, no attribute)?
export function selectsEveryEntity(cond) {
  return !(cond?.entityIds?.length > 0) && !cond?.attribute;
}

function pickedText(cond) {
  const ids = cond.entityIds || [];
  const labels = cond.labels || {};
  const names = ids.slice(0, CHIP_LABEL_LIMIT).map(id => labels[id] || String(id).slice(0, 8));
  const more = ids.length - CHIP_LABEL_LIMIT;
  return more > 0 ? `${names.join(', ')} +${more} more` : names.join(', ');
}

// The chip's text, e.g.
//   "Organisation · Klant · iso27001 = Ja · via eigenaar, team"
//   "Organisation · Klant: Contoso Bank, Northwind"
//   "Organisation · every Klant"
export function orgConditionText(cond) {
  const type = cond?.entityType || '?';
  const parts = ['Organisation'];
  if (cond?.entityIds?.length > 0) parts.push(`${type}: ${pickedText(cond)}`);
  else if (cond?.attribute) parts.push(type);
  else parts.push(`every ${type}`);
  if (cond?.attribute) parts.push(`${cond.attribute.key} = ${(cond.attribute.values || []).join(', ')}`);
  if (cond?.via?.length > 0) parts.push(`via ${cond.via.join(', ')}`);
  return parts.join(' · ');
}
