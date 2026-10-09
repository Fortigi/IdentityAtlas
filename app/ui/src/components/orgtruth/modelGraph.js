// Pure layout + Mermaid export for the Organisation → Model diagram.
//
// Input is the GET /api/org-truth/model payload (T4):
//   { entityTypes: [{ type, count, proposed, attributeKeys, sources, lastObservedAt }],
//     predicates:  [{ predicate, fromType, toType, count, proposed }],
//     links:       [{ entityType, targetType, via, accepted, proposed }],   // to the system truth, per attribute
//     entityLinks: [{ fromType, toType, via, accepted, proposed }],         // between two organisation lists
//     systemTypes: [{ targetType, count }], totals: {...} }
//
// The diagram is two rows, hand-laid-out (no graph library):
//   row 1  entity types, sorted by count desc (then name), width from label length;
//   row 2  the system types that appear in `links`, sorted by linked total desc;
// predicates are curved arcs above row 1 (a self-relation is a loop); links
// between two lists are dashed arcs between their row-1 nodes, stacked with the
// predicates of the same pair; links to the system truth are dashed straight
// lines from an entity type down to a system type, one per attribute (`via`),
// fanned out over the width of the entity node. Every label sits at its edge's
// midpoint, offset along the edge normal, and labels that would overlap are
// staggered (staggerLabels). Every number is a function of the input only.

export const NODE_H = 44;
export const LABEL_H = 16;
const MARGIN = 24;
const GAP_X = 48;
const ROW_GAP = 150;
const CHAR_W = 7.2;
const MIN_W = 96;
const LABEL_PAD = 56;
const ARC_BASE = 48;
const ARC_PER_PX = 0.18;
const ARC_MAX = 160;
const ARC_STACK = 26;
const LOOP_H = 40;
const LABEL_CHAR_W = 6.2;
const ARC_LABEL_OFFSET = 4;
const LINE_LABEL_OFFSET = 8;
const STAGGER_TRIES = 40;
const TOP_ROOM = 4;

export function nodeWidth(label) {
  return Math.max(MIN_W, Math.round(String(label).length * CHAR_W + LABEL_PAD));
}

// Width of an edge label's background box (11 px text plus padding).
export function labelWidth(text) {
  return String(text).length * LABEL_CHAR_W + 10;
}

const viaName = (via) => ((via ?? 'displayName') === 'displayName' ? 'name' : via);

// "team: 12 accepted · 3 proposed"; the entity's own name reads as "name".
export function linkLabel(via, accepted, proposed) {
  const p = Number(proposed) || 0;
  return `${viaName(via)}: ${Number(accepted) || 0} accepted${p ? ` · ${p} proposed` : ''}`;
}

// Two centre-based boxes { x, y, w, h } overlap when they intersect in both
// axes; boxes that only touch do not.
export function boxesOverlap(a, b) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
}

// Place labels in order; a label that overlaps one placed before it moves by
// `step` in its own direction (`dir` < 0 up, otherwise down) until it is
// clear. Returns the final y of every box (x never changes).
export function staggerLabels(boxes, step = LABEL_H + 2) {
  const placed = [];
  return boxes.map(b => {
    let box = { ...b };
    for (let i = 0; i < STAGGER_TRIES && placed.some(p => boxesOverlap(box, p)); i++) {
      box = { ...box, y: box.y + (b.dir < 0 ? -step : step) };
    }
    placed.push(box);
    return box.y;
  });
}

// Every edge carries `anchor` (midpoint + unit normal) and `offset`; this
// turns them into labelX/labelY/labelW with overlaps staggered away.
export function placeEdgeLabels(edges) {
  const boxes = edges.map(e => ({
    x: e.anchor.x + e.anchor.nx * e.offset,
    y: e.anchor.y + e.anchor.ny * e.offset,
    w: labelWidth(e.label),
    h: LABEL_H,
    dir: e.anchor.ny < 0 ? -1 : 1,
  }));
  const ys = staggerLabels(boxes);
  return edges.map((e, i) => ({ ...e, labelX: boxes[i].x, labelY: ys[i], labelW: boxes[i].w }));
}

function byCountThenName(a, b) {
  return (b.count - a.count) || String(a.label).localeCompare(String(b.label));
}

function placeRow(items, y) {
  let x = 0;
  return items.map(it => {
    const w = nodeWidth(it.label);
    const node = { ...it, x, y, w, h: NODE_H };
    x += w + GAP_X;
    return node;
  });
}

function rowWidth(row) {
  if (row.length === 0) return 0;
  const last = row[row.length - 1];
  return last.x + last.w;
}

function shiftRow(row, dx) {
  return row.map(n => ({ ...n, x: n.x + dx }));
}

function entityNodes(model) {
  return (model?.entityTypes || []).map(t => ({
    id: `t:${t.type}`,
    kind: 'entity',
    label: t.type,
    count: Number(t.count) || 0,
    proposed: Number(t.proposed) || 0,
    attributeKeys: t.attributeKeys || [],
    sources: t.sources ?? null,
  })).sort(byCountThenName);
}

const systemLinks = (model) => (model?.links || []).filter(l => l.targetType !== 'OrgEntity');

function systemNodes(model) {
  const linked = new Map();
  for (const l of systemLinks(model)) {
    const total = (Number(l.accepted) || 0) + (Number(l.proposed) || 0);
    linked.set(l.targetType, (linked.get(l.targetType) || 0) + total);
  }
  const counts = new Map((model?.systemTypes || []).map(s => [s.targetType, s.count]));
  return [...linked.entries()].map(([type, total]) => ({
    id: `s:${type}`,
    kind: 'system',
    label: type,
    count: total,
    systemCount: counts.has(type) ? Number(counts.get(type)) : null,
  })).sort(byCountThenName);
}

// Arc height for an arc between two row-1 nodes; `stack` separates several
// arcs drawn between the same pair.
function arcHeight(dx, stack) {
  return Math.min(ARC_MAX, ARC_BASE + Math.abs(dx) * ARC_PER_PX) + stack * ARC_STACK;
}

// Predicates first, then the links between two lists: both are arcs in row 1.
function arcSpecs(model) {
  const preds = (model?.predicates || []).map(p => ({
    fromType: p.fromType, toType: p.toType, kind: 'predicate',
    id: `p:${p.fromType}:${p.predicate}:${p.toType}`,
    label: `${p.predicate} ${Number(p.count) || 0}`,
  }));
  const lists = (model?.entityLinks || []).map(l => ({
    fromType: l.fromType, toType: l.toType, kind: 'entityLink', dashed: true,
    id: `e:${l.fromType}:${l.via ?? 'displayName'}:${l.toType}`,
    label: linkLabel(l.via, l.accepted, l.proposed),
  }));
  return [...preds, ...lists];
}

function arcEdge(a, b, stack, spec) {
  const { id, kind, label, dashed } = spec;
  const base = { id, kind, label, dashed: dashed === true, from: a.id, to: b.id, offset: ARC_LABEL_OFFSET };
  if (a === b) {
    const h = LOOP_H + stack * ARC_STACK;
    const x1 = a.x + a.w * 0.3;
    const x2 = a.x + a.w * 0.7;
    return { ...base, peak: h * 0.75,
      path: `M ${x1} ${a.y} C ${x1} ${a.y - h} ${x2} ${a.y - h} ${x2} ${a.y}`,
      anchor: { x: a.x + a.w / 2, y: a.y - h * 0.75, nx: 0, ny: -1 } };
  }
  const x1 = a.x + a.w / 2;
  const x2 = b.x + b.w / 2;
  const h = arcHeight(x2 - x1, stack);
  const mx = (x1 + x2) / 2;
  return { ...base, peak: h / 2,
    path: `M ${x1} ${a.y} Q ${mx} ${a.y - h} ${x2} ${b.y}`,
    anchor: { x: mx, y: a.y - h / 2, nx: 0, ny: -1 } };
}

function arcEdges(model, nodeById) {
  const perPair = new Map();
  const edges = [];
  for (const spec of arcSpecs(model)) {
    const a = nodeById.get(`t:${spec.fromType}`);
    const b = nodeById.get(`t:${spec.toType}`);
    if (!a || !b) continue;
    const pair = [spec.fromType, spec.toType].sort().join('|');
    const stack = perPair.get(pair) || 0;
    perPair.set(pair, stack + 1);
    edges.push(arcEdge(a, b, stack, spec));
  }
  return edges;
}

function lineEdge(a, b, x1, l) {
  const y1 = a.y + a.h;
  const x2 = b.x + b.w / 2;
  const dx = x2 - x1;
  const dy = b.y - y1;
  const len = Math.hypot(dx, dy);
  return {
    id: `l:${l.entityType}:${l.targetType}:${l.via ?? 'displayName'}`,
    kind: 'link', from: a.id, to: b.id, dashed: true,
    label: linkLabel(l.via, l.accepted, l.proposed),
    path: `M ${x1} ${y1} L ${x2} ${b.y}`,
    anchor: { x: (x1 + x2) / 2, y: (y1 + b.y) / 2, nx: -dy / len, ny: dx / len },
    offset: LINE_LABEL_OFFSET,
  };
}

// One straight line per (entity type, target type, via); the lines leaving one
// entity node start at evenly spaced points along its bottom edge.
function linkEdges(model, nodeById) {
  const links = systemLinks(model).filter(l => nodeById.has(`t:${l.entityType}`) && nodeById.has(`s:${l.targetType}`));
  const perNode = new Map();
  for (const l of links) perNode.set(l.entityType, (perNode.get(l.entityType) || 0) + 1);
  const seen = new Map();
  return links.map(l => {
    const a = nodeById.get(`t:${l.entityType}`);
    const k = seen.get(l.entityType) || 0;
    seen.set(l.entityType, k + 1);
    const x1 = a.x + (a.w * (k + 1)) / (perNode.get(l.entityType) + 1);
    return lineEdge(a, nodeById.get(`s:${l.targetType}`), x1, l);
  });
}

function build(model, row1, row2, inner, top) {
  const centre = (row) => (inner - rowWidth(row)) / 2 + MARGIN;
  const r1 = shiftRow(row1, centre(row1)).map(n => ({ ...n, y: top }));
  const r2 = shiftRow(row2, centre(row2)).map(n => ({ ...n, y: top + NODE_H + ROW_GAP }));
  const nodes = [...r1, ...r2];
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const edges = placeEdgeLabels([...arcEdges(model, nodeById), ...linkEdges(model, nodeById)]);
  return { nodes, edges, hasRow2: r2.length > 0 };
}

// Arcs are drawn above row 1, so first measure how high the tallest one
// reaches with a provisional y of 0, then move both rows down by that much
// (and further when a staggered label would still poke out of the top).
export function layoutModel(model) {
  const row1 = placeRow(entityNodes(model), 0);
  const row2 = placeRow(systemNodes(model), 0);
  const inner = Math.max(rowWidth(row1), rowWidth(row2), MIN_W);
  const provisional = new Map(row1.map(n => [n.id, n]));
  const maxPeak = arcEdges(model, provisional).reduce((m, e) => Math.max(m, e.peak), 0);
  let top = MARGIN + (maxPeak > 0 ? maxPeak + 18 : 0);
  let out = build(model, row1, row2, inner, top);
  const highest = out.edges.reduce((m, e) => Math.min(m, e.labelY - LABEL_H / 2), Infinity);
  if (highest < TOP_ROOM) {
    top += TOP_ROOM - highest;
    out = build(model, row1, row2, inner, top);
  }
  const bottom = out.hasRow2 ? top + NODE_H * 2 + ROW_GAP : top + NODE_H;
  return { width: inner + MARGIN * 2, height: bottom + MARGIN, nodes: out.nodes, edges: out.edges };
}

// ─── Mermaid ─────────────────────────────────────────────────────────

function mermaidId(prefix, name) {
  return `${prefix}_${String(name).replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function escapeMermaid(s) {
  return String(s).replace(/"/g, '#quot;').replace(/\|/g, '#124;');
}

// The same model as Mermaid flowchart text: one node per entity type and per
// linked system type, a solid arrow per predicate, a dotted arrow per link
// between two lists and per link to the system truth.
export function mermaidText(model) {
  const lines = ['graph LR'];
  for (const n of entityNodes(model)) {
    lines.push(`  ${mermaidId('t', n.label)}["${escapeMermaid(n.label)} (${n.count})"]`);
  }
  for (const n of systemNodes(model)) {
    const count = n.systemCount != null ? ` (${n.systemCount})` : '';
    lines.push(`  ${mermaidId('s', n.label)}[["${escapeMermaid(n.label)}${count}"]]`);
  }
  for (const p of model?.predicates || []) {
    lines.push(`  ${mermaidId('t', p.fromType)} -->|"${escapeMermaid(p.predicate)} ${Number(p.count) || 0}"| ${mermaidId('t', p.toType)}`);
  }
  for (const l of model?.entityLinks || []) {
    lines.push(`  ${mermaidId('t', l.fromType)} -.->|"${escapeMermaid(linkLabel(l.via, l.accepted, l.proposed))}"| ${mermaidId('t', l.toType)}`);
  }
  for (const l of systemLinks(model)) {
    lines.push(`  ${mermaidId('t', l.entityType)} -.->|"${escapeMermaid(linkLabel(l.via, l.accepted, l.proposed))}"| ${mermaidId('s', l.targetType)}`);
  }
  return lines.join('\n');
}

// Rows for the table view, sorted by count (desc by default, then name).
export function sortByCount(rows, dir = 'desc') {
  const mult = dir === 'asc' ? 1 : -1;
  const name = (r) => String(r.type ?? r.predicate ?? '');
  return [...(rows || [])].sort((a, b) =>
    ((Number(a.count) || 0) - (Number(b.count) || 0)) * mult || name(a).localeCompare(name(b)));
}
