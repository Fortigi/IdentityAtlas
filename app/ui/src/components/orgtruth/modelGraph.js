// Mermaid export of the Organisation → Model, plus the label-placement helpers
// the model canvas (modelCanvas.js, RuleCanvas.jsx) reuses.
//
// Input is the GET /api/org-truth/model payload:
//   { entityTypes: [{ type, count, proposed, attributeKeys, sources, lastObservedAt }],
//     predicates:  [{ predicate, fromType, toType, count, proposed }],
//     links:       [{ entityType, targetType, via, accepted, proposed }],   // to the connected systems, per attribute
//     entityLinks: [{ fromType, toType, via, accepted, proposed }],         // between two organisation lists
//     systemTypes: [{ targetType, count }], totals: {...} }

export const LABEL_H = 16;
const LABEL_CHAR_W = 6.2;
const STAGGER_TRIES = 40;

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

function byCountThenName(a, b) {
  return (b.count - a.count) || String(a.label).localeCompare(String(b.label));
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
