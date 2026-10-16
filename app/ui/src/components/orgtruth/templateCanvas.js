// Organisation → Model → the model canvas: the three import templates that are
// NOT cards (modelCanvas.js draws only collection types as cards).
//
//   enrichment  an attribute block attached to its target system card:
//               "+ expertises · level" with its source ("Maten") — the extra
//               attributes those objects now carry (GET /model `enrichments`).
//   activity    a dashed edge from the actor system card to the subject card
//               (a collection type, or Group/resource), labelled
//               "Uren · 1,152 rows · h" (GET /model `activities`).
//   relation    a dashed edge between its two end types, labelled with the
//               predicate and how many pairs (GET /model `pairs`); an SoD list
//               between two resources is a loop on the resource card.
//
// Every number is a function of the input only.
import { HEADER_H, linePath, withLabelYs } from './modelCanvas';
import { labelWidth } from './modelGraph';

const LOOP_W = 48;
const LOOP_STEP = 18;

// The blocks of one system card, one per enrichment that targets it.
export function enrichmentBlocks(enrichments, targetType) {
  return (enrichments ?? [])
    .filter(e => e.targetType === targetType)
    .map(e => ({
      id: `x:${e.profileName ?? e.type}`,
      label: `+ ${(e.attributes ?? []).map(a => (a.multi ? `${a.name} (multiple)` : a.name)).join(' · ')}`,
      source: e.type,
      owner: e.profileName ?? null,
    }));
}

// The cards with their enrichment blocks attached (system cards only).
export function withEnrichmentBlocks(boxes, enrichments) {
  return boxes.map(b => (b.kind === 'system' ? { ...b, blocks: enrichmentBlocks(enrichments, b.targetType) } : b));
}

// The card an end type stands for: a system card when the type is a system
// target ('Principal', 'Resource', …), else the collection card of that name.
export function endBoxId(type, entityType, boxes) {
  if (type === 'OrgEntity') return `e:${entityType}`;
  return boxes.has(`s:${type}`) ? `s:${type}` : `e:${type}`;
}

// A loop on the right side of a card's header, the k-th one a little wider.
export function loopPath(box, k = 0) {
  const x = box.x + box.w;
  const y1 = box.y + 8;
  const y2 = box.y + HEADER_H - 8;
  const out = x + LOOP_W + k * LOOP_STEP;
  return { path: `M ${x} ${y1} C ${out} ${y1 - 24} ${out} ${y2 + 24} ${x} ${y2}`, mid: { x: x + (out - x) * 0.75, y: (y1 + y2) / 2 } };
}

function edge(from, to, loops) {
  if (from !== to) return linePath(from, from.y + HEADER_H / 2, to, to.y + HEADER_H / 2);
  const k = loops.get(from.id) ?? 0;
  loops.set(from.id, k + 1);
  return loopPath(from, k);
}

export function activityLabel(a) {
  const rows = Number(a.rows) || 0;
  return [a.type, `${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}`, a.unit].filter(Boolean).join(' · ');
}

const pairLabel = (p) => `${p.predicate} ${Number(p.count) || 0}`;

// The edges of the activities and relation pairs; one whose end is not on the
// canvas is left out.
export function templateEdges(placed, model) {
  const boxes = new Map(placed.map(b => [b.id, b]));
  const loops = new Map();
  const lines = [];
  const push = (key, kind, owner, fromId, toId, label) => {
    const from = boxes.get(fromId);
    const to = boxes.get(toId);
    if (!from || !to) return;
    const { path, mid } = edge(from, to, loops);
    lines.push({ key, kind, owners: [owner], path, mid, label, labelW: labelWidth(label) });
  };
  for (const a of model?.activities ?? []) {
    const actor = (a.actorTypes ?? []).map(t => `s:${t}`).find(id => boxes.has(id));
    push(`a:${a.profileName ?? a.type}`, 'activity', a.profileName ?? null, actor, endBoxId(a.subjectType, a.subjectEntityType, boxes), activityLabel(a));
  }
  for (const p of model?.pairs ?? []) {
    push(`r:${p.type}:${p.predicate}`, 'relation', p.profileName ?? null, endBoxId(p.leftType, p.leftEntityType, boxes), endBoxId(p.rightType, p.rightEntityType, boxes), pairLabel(p));
  }
  return withLabelYs(lines);
}
