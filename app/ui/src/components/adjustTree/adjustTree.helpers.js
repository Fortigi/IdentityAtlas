// Pure helpers behind the Adjust tree screen (docs/architecture/adjust-tree.md
// §5). The API sends the tree flat (`units`, each with its `parentId`); these
// turn it into the nested tree the screen draws, decide what a drop means, find
// the units a search should show, and hold the screen's words. No React here,
// so every rule is unit-tested on its own.

import { memberKindNoun } from '@ui/utils/contextStyles';
import { formatDateOnly } from '@ui/utils/formatters';

// The id of the drop zone that moves a unit to the top level of the tree.
export const TOP_LEVEL_DROP_ID = '__top-level__';

const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
// The Not placed unit (people outside the chosen top) sorts after the tree.
const rootOrder = (a, b) => (a.notPlaced ? 1 : 0) - (b.notPlaced ? 1 : 0) || byName(a, b);

// The flat unit list as nested roots: { ...unit, children: [...] }, siblings by
// name. A unit whose parent is not in the list (or that names itself) is a
// root, so a tree the API cut short still draws every unit. Not placed goes last.
export function buildTree(units) {
  const nodes = new Map((units || []).map(u => [u.id, { ...u, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parentId != null && node.parentId !== node.id ? nodes.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) node.children.sort(byName);
  return roots.sort(rootOrder);
}

// The units open when the tree first shows: the top level and the level below.
export function initialOpen(roots) {
  const open = new Set();
  for (const r of roots || []) {
    open.add(r.id);
    for (const c of r.children || []) open.add(c.id);
  }
  return open;
}

// Unit id → unit, for lookups by the panels.
export function indexUnits(units) {
  return new Map((units || []).map(u => [u.id, u]));
}

// The id of a unit plus every unit below it, from the flat list. A unit can't
// be moved onto any of these. Guards against a parent loop in the data.
export function subtreeIds(units, id) {
  const children = new Map();
  for (const u of units || []) {
    if (u.parentId == null) continue;
    if (!children.has(u.parentId)) children.set(u.parentId, []);
    children.get(u.parentId).push(u.id);
  }
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue;
    out.add(cur);
    for (const c of children.get(cur) || []) stack.push(c);
  }
  return out;
}

// The ids above a unit, nearest first (its parent, then that one's parent…).
export function ancestorIds(byId, id) {
  const out = [];
  const seen = new Set([id]);
  let cur = byId.get(id)?.parentId;
  while (cur != null && byId.has(cur) && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = byId.get(cur).parentId;
  }
  return out;
}

// What dropping a dragged thing onto a target means: the adjustment to post
// ({ op, ... }), or { error } when the drop is not allowed, or null for a drop
// that changes nothing. `drag` is the dragged item's data:
//   { type: 'unit', unitId }  or  { type: 'member', memberId, fromUnitId }.
export function resolveDrop(drag, targetId, units) {
  if (!drag || targetId == null) return null;
  if (drag.type === 'member') return memberDrop(drag, targetId);
  if (drag.type !== 'unit') return null;
  const unit = (units || []).find(u => u.id === drag.unitId);
  if (!unit) return null;
  const toParentId = targetId === TOP_LEVEL_DROP_ID ? null : targetId;
  if (unit.notPlaced) return null;
  // Dropped back where it is: on itself, or on the parent it already has.
  if (toParentId === unit.id || (unit.parentId ?? null) === toParentId) return null;
  if (toParentId !== null && subtreeIds(units, unit.id).has(toParentId)) {
    return { error: "You can't move a unit into one of its own sub-units." };
  }
  if (toParentId !== null && units.find(u => u.id === toParentId)?.notPlaced) {
    return { error: "Units can't be moved into Not placed." };
  }
  return { op: 'moveUnit', subjectId: unit.id, toParentId };
}

function memberDrop(drag, targetId) {
  if (targetId === TOP_LEVEL_DROP_ID || targetId === drag.fromUnitId) return null;
  return { op: 'moveMember', memberId: drag.memberId, fromUnitId: drag.fromUnitId, toUnitId: targetId };
}

// The search over unit names: which units to show (the matches and the units
// above them) and which to open (the units above a match). An empty query shows
// everything and forces nothing open (`visible` null).
export function searchUnits(units, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return { visible: null, open: new Set(), matches: new Set() };
  const byId = indexUnits(units);
  const matches = new Set((units || []).filter(u => (u.name || '').toLowerCase().includes(q)).map(u => u.id));
  const visible = new Set(matches);
  const open = new Set();
  for (const id of matches) {
    for (const a of ancestorIds(byId, id)) { visible.add(a); open.add(a); }
  }
  return { visible, open, matches };
}

// The members a tree holds, as a lower-case noun: people for a tree of people
// or accounts (an organisation of people), else the kind's own noun.
export function memberWord(targetType, count = 2) {
  if (targetType === 'Principal' || targetType === 'Identity') return count === 1 ? 'person' : 'people';
  return memberKindNoun(targetType, count);
}

// The second line of a member: where they work, or what kind of resource it is.
export function memberDetail(m) {
  return m?.department || m?.jobTitle || m?.resourceType || m?.email || '';
}

// "Show people" / "Show resources" — the toggle that lists members in the tree.
export function showMembersLabel(targetType) {
  return `Show ${memberWord(targetType)}`;
}

// A people tree splits by an attribute value (department…); any other tree by
// picking the members.
export function isPeopleTree(targetType) {
  return targetType === 'Principal' || targetType === 'Identity';
}

// The row's count: direct members, and the total with sub-units when it differs.
export function countText(unit) {
  const direct = unit?.memberCount ?? 0;
  const total = unit?.totalMemberCount ?? direct;
  return total !== direct ? `${direct} / ${total}` : String(direct);
}

// The marks after a unit's name, in display order.
export function unitMarks(unit) {
  const marks = [];
  if (unit?.adjusted) marks.push({ key: 'adjusted', label: 'adjusted', tone: 'neutral' });
  if (unit?.createdByAdjustment) marks.push({ key: 'added', label: 'added by hand', tone: 'neutral' });
  if (unit?.interim) {
    const until = unit.interim.validUntil ? ` until ${formatDateOnly(unit.interim.validUntil)}` : '';
    marks.push({ key: 'interim', label: `interim${until}`, tone: 'warn' });
  }
  return marks;
}

// Status of an adjustment → its pill.
const STATUS_META = {
  active:        { label: 'Applied',             tone: 'ok' },
  needsDecision: { label: 'Needs your decision', tone: 'warn' },
  orphaned:      { label: 'No longer applies',   tone: 'bad' },
  matches:       { label: 'Source agrees',       tone: 'warn' },
  expired:       { label: 'Expired',             tone: 'warn' },
  reverted:      { label: 'Undone',              tone: 'neutral' },
};
export function statusMeta(status) {
  return STATUS_META[status] || { label: status || 'Unknown', tone: 'neutral' };
}

// Adjustments that still count (everything not undone) — the tab's badge.
export function liveAdjustments(adjustments) {
  return (adjustments || []).filter(a => a.status !== 'reverted');
}

// The ids an adjustment names in its payload as a target unit, or as the unit
// it created (addUnit / splitUnit: `contextId`).
function targetIds(adj) {
  const p = adj.payload || {};
  return [p.toParentId, p.toUnitId, p.parentId, p.contextId].filter(v => v != null);
}

// The live adjustments that touch one unit: as their subject, as the unit
// something was moved into or added under, or as the unit they created.
export function adjustmentsForUnit(adjustments, unitId) {
  return liveAdjustments(adjustments).filter(a => a.subjectId === unitId || targetIds(a).includes(unitId));
}

// One line of who and when: "Wim · 10 Oct 2026".
export function byLine(adj) {
  return [adj.createdBy, adj.createdAt ? formatDateOnly(adj.createdAt) : null].filter(Boolean).join(' · ');
}

// Where the tree comes from, in the header: "Generated from Entra ID".
const KIND_WORD = { generated: 'Generated', synced: 'Imported', manual: 'Built by hand' };
export function sourceText(tree) {
  const word = KIND_WORD[tree?.kind] || 'Tree';
  const system = tree?.source?.systemName;
  if (tree?.kind === 'manual' || !system) return word;
  return `${word} from ${system}`;
}

// Text of the toast after a change, from the API's sentence or the op.
const OP_DONE = {
  moveUnit: 'Unit moved', renameUnit: 'Unit renamed', moveMember: 'Moved', addUnit: 'Unit added',
  splitUnit: 'Unit split', setManager: 'Manager set',
};
export function doneText(adjustment, op) {
  return adjustment?.description || OP_DONE[op] || 'Saved';
}

// The id of the unit an addUnit created: the one its payload names
// (`payload.contextId`) when the re-read tree holds it, else the one unit with
// that name under that parent. Not the adjustment's subject: for addUnit that
// is the parent the unit was added under.
export function addedUnitId(adjustment, units, { name, parentId }) {
  const ids = new Set((units || []).map(u => u.id));
  const created = adjustment?.payload?.contextId;
  if (created && ids.has(created)) return created;
  const hits = (units || []).filter(u => u.name === name && (u.parentId ?? null) === (parentId ?? null));
  return hits.length === 1 ? hits[0].id : null;
}

// The parent a new grouping unit sits under: the one parent every picked unit
// shares, else the top level.
export function commonParentId(units, ids) {
  const byId = indexUnits(units);
  const parents = new Set([...ids].map(id => byId.get(id)?.parentId ?? null));
  return parents.size === 1 ? [...parents][0] : null;
}

// The units a unit can be moved under: every unit outside its own subtree that
// is not already its parent nor Not placed, by name.
export function moveTargets(units, unitId) {
  const blocked = subtreeIds(units, unitId);
  const unit = (units || []).find(u => u.id === unitId);
  return (units || [])
    .filter(u => !blocked.has(u.id) && u.id !== unit?.parentId && !u.notPlaced)
    .sort(byName);
}

// The adjustment body with the optional reason added only when one was typed.
export function withReason(body, reason) {
  const r = (reason || '').trim();
  return r ? { ...body, reason: r } : body;
}

// Whether a Needs attention fix is offered: every fix to someone who may change
// the tree, only "select" (show me the unit) to a reader.
export function actionAllowed(action, editable) {
  if (!action?.type) return false;
  return !!editable || action.type === 'select';
}
