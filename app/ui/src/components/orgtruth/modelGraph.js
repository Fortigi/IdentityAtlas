// Pure layout + Mermaid export for the Organisation → Model diagram.
//
// Input is the GET /api/org-truth/model payload (T4):
//   { entityTypes: [{ type, count, proposed, attributeKeys, sources, lastObservedAt }],
//     predicates:  [{ predicate, fromType, toType, count, proposed }],
//     links:       [{ entityType, targetType, accepted, proposed }],
//     systemTypes: [{ targetType, count }], totals: {...} }
//
// The diagram is two rows, hand-laid-out (no graph library):
//   row 1  entity types, sorted by count desc (then name), width from label length;
//   row 2  the system types that appear in `links`, sorted by linked total desc;
// predicates are curved arcs above row 1 (a self-relation is a loop), links are
// dashed straight lines from an entity type down to a system type. Every number
// is a function of the input only, so the same model always draws the same.

export const NODE_H = 44;
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

export function nodeWidth(label) {
  return Math.max(MIN_W, Math.round(String(label).length * CHAR_W + LABEL_PAD));
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

function systemNodes(model) {
  const linked = new Map();
  for (const l of model?.links || []) {
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

// Arc height for a predicate between two row-1 nodes; `stack` separates
// several predicates drawn between the same pair.
function arcHeight(dx, stack) {
  return Math.min(ARC_MAX, ARC_BASE + Math.abs(dx) * ARC_PER_PX) + stack * ARC_STACK;
}

function predicateEdges(model, nodeById) {
  const perPair = new Map();
  const edges = [];
  for (const p of model?.predicates || []) {
    const a = nodeById.get(`t:${p.fromType}`);
    const b = nodeById.get(`t:${p.toType}`);
    if (!a || !b) continue;
    const pair = [p.fromType, p.toType].sort().join('|');
    const stack = perPair.get(pair) || 0;
    perPair.set(pair, stack + 1);
    const label = `${p.predicate} ${Number(p.count) || 0}`;
    const id = `p:${p.fromType}:${p.predicate}:${p.toType}`;
    if (a === b) {
      const h = LOOP_H + stack * ARC_STACK;
      const x1 = a.x + a.w * 0.3;
      const x2 = a.x + a.w * 0.7;
      edges.push({ id, kind: 'predicate', from: a.id, to: b.id, label,
        path: `M ${x1} ${a.y} C ${x1} ${a.y - h} ${x2} ${a.y - h} ${x2} ${a.y}`,
        labelX: a.x + a.w / 2, labelY: a.y - h * 0.75 - 4, peak: h * 0.75 });
      continue;
    }
    const x1 = a.x + a.w / 2;
    const x2 = b.x + b.w / 2;
    const h = arcHeight(x2 - x1, stack);
    const mx = (x1 + x2) / 2;
    edges.push({ id, kind: 'predicate', from: a.id, to: b.id, label,
      path: `M ${x1} ${a.y} Q ${mx} ${a.y - h} ${x2} ${b.y}`,
      labelX: mx, labelY: a.y - h / 2 - 4, peak: h / 2 });
  }
  return edges;
}

function linkEdges(model, nodeById) {
  const edges = [];
  for (const l of model?.links || []) {
    const a = nodeById.get(`t:${l.entityType}`);
    const b = nodeById.get(`s:${l.targetType}`);
    if (!a || !b) continue;
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    edges.push({
      id: `l:${l.entityType}:${l.targetType}`,
      kind: 'link', from: a.id, to: b.id, dashed: true,
      label: `${Number(l.accepted) || 0} accepted · ${Number(l.proposed) || 0} proposed`,
      path: `M ${x1} ${y1} L ${x2} ${b.y}`,
      labelX: (x1 + x2) / 2, labelY: (y1 + b.y) / 2,
    });
  }
  return edges;
}

// Arcs are drawn above row 1, so first measure how high the tallest one
// reaches with a provisional y of 0, then move both rows down by that much.
export function layoutModel(model) {
  const row1 = placeRow(entityNodes(model), 0);
  const row2 = placeRow(systemNodes(model), 0);
  const inner = Math.max(rowWidth(row1), rowWidth(row2), MIN_W);
  const provisional = new Map(row1.map(n => [n.id, n]));
  const maxPeak = predicateEdges(model, provisional).reduce((m, e) => Math.max(m, e.peak), 0);
  const top = MARGIN + (maxPeak > 0 ? maxPeak + 18 : 0);
  const centre = (row) => (inner - rowWidth(row)) / 2 + MARGIN;

  const r1 = shiftRow(row1, centre(row1)).map(n => ({ ...n, y: top }));
  const r2 = shiftRow(row2, centre(row2)).map(n => ({ ...n, y: top + NODE_H + ROW_GAP }));
  const nodes = [...r1, ...r2];
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const edges = [...predicateEdges(model, nodeById), ...linkEdges(model, nodeById)];
  const bottom = r2.length > 0 ? top + NODE_H * 2 + ROW_GAP : top + NODE_H;
  return { width: inner + MARGIN * 2, height: bottom + MARGIN, nodes, edges };
}

// ─── Mermaid ─────────────────────────────────────────────────────────

function mermaidId(prefix, name) {
  return `${prefix}_${String(name).replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function escapeMermaid(s) {
  return String(s).replace(/"/g, '#quot;').replace(/\|/g, '#124;');
}

// The same model as Mermaid flowchart text: one node per entity type and per
// linked system type, a solid arrow per predicate, a dotted arrow per link.
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
  for (const l of model?.links || []) {
    lines.push(`  ${mermaidId('t', l.entityType)} -.->|"${Number(l.accepted) || 0} accepted · ${Number(l.proposed) || 0} proposed"| ${mermaidId('s', l.targetType)}`);
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
