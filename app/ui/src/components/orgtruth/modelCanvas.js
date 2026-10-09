// Organisation → Model → Link rules: the pure geometry of the rule canvas (a
// "model view" in the Power BI / Access sense: boxes with one row per
// attribute, relations drawn from attribute row to field row).
//
//   top row     one box per organisation entity type: first this profile's own
//               entity types (recipe order; every attribute row is a source),
//               then the other lists' entity types by name (only their name
//               row, which is a target: targetType OrgEntity);
//   bottom row  one box per system target (Account, Person, Group/resource,
//               Context) with a row per matchable field (all targets).
//
// A rule is a cubic line from its source row (rule.via) to its target row
// (lineField), leaving and entering the boxes on their facing sides, with its
// label at the curve's midpoint (staggered like the overview diagram's).
// Every number is a function of the input only.
import { NAME_ATTRIBUTE, entityAttributeNames, ruleVia } from './wizard/wizardDraft';
import { LABEL_H, labelWidth, staggerLabels } from './modelGraph';
import {
  SYSTEM_TARGETS, viaLabel, lineField, targetTitle, targetFieldLabel, ruleCounts, lineLabel,
} from './linkRulesDraft';

export const BOX_W = 200;
export const HEADER_H = 32;
export const ROW_H = 26;
const GAP_X = 96;
const ROW_GAP = 110;
const MARGIN = 24;
const HANDLE_MIN = 40;

function entityBox(type, attributes, count, own) {
  return {
    id: `e:${type}`, kind: 'entity', own, title: type, entityType: type, count,
    rows: attributes.map(a => ({
      id: `e:${type}|${a}`, label: viaLabel(a), attribute: a, entityType: type, source: own,
      target: a === NAME_ATTRIBUTE ? { targetType: 'OrgEntity', targetEntityType: type, field: NAME_ATTRIBUTE } : null,
    })),
  };
}

function systemBox(s, count) {
  return {
    id: `s:${s.targetType}`, kind: 'system', own: false, title: s.title, targetType: s.targetType, count,
    rows: s.fields.map(f => ({
      id: `s:${s.targetType}|${f}`, label: f, source: false, target: { targetType: s.targetType, field: f },
    })),
  };
}

// The boxes of one profile's canvas, before placement.
export function canvasBoxes(profile, model) {
  const own = profile?.recipe?.entities ?? [];
  const counts = new Map((model?.entityTypes ?? []).map(t => [t.type, Number(t.count) || 0]));
  const ownTypes = new Set(own.map(e => e.type));
  const others = (model?.entityTypes ?? []).map(t => t.type).filter(t => !ownTypes.has(t)).sort();
  const systemCounts = new Map((model?.systemTypes ?? []).map(s => [s.targetType, Number(s.count) || 0]));
  return {
    entities: [
      ...own.map(e => entityBox(e.type, entityAttributeNames(e), counts.get(e.type) ?? null, true)),
      ...others.map(t => entityBox(t, [NAME_ATTRIBUTE], counts.get(t) ?? null, false)),
    ],
    systems: SYSTEM_TARGETS.map(s => systemBox(s, systemCounts.get(s.targetType) ?? null)),
  };
}

const boxHeight = (box) => HEADER_H + box.rows.length * ROW_H;
const rowSpan = (n) => (n > 0 ? n * BOX_W + (n - 1) * GAP_X : 0);

function placeBoxes(boxes, y, inner) {
  const left = MARGIN + (inner - rowSpan(boxes.length)) / 2;
  return boxes.map((b, i) => {
    const x = left + i * (BOX_W + GAP_X);
    return {
      ...b, x, y, w: BOX_W, h: boxHeight(b),
      rows: b.rows.map((r, k) => ({ ...r, boxId: b.id, boxTitle: b.title, x, y: y + HEADER_H + k * ROW_H, cy: y + HEADER_H + k * ROW_H + ROW_H / 2 })),
    };
  });
}

// { width, height, boxes: [{ id, kind, own, title, count, x, y, w, h, rows: [{ id, label, x, y, cy, source, target, … }] }] }
export function layoutCanvas(profile, model) {
  const { entities, systems } = canvasBoxes(profile, model);
  const inner = Math.max(rowSpan(entities.length), rowSpan(systems.length));
  const topH = entities.reduce((m, b) => Math.max(m, boxHeight(b)), 0);
  const top = placeBoxes(entities, MARGIN, inner);
  const bottomY = MARGIN + topH + ROW_GAP;
  const bottom = placeBoxes(systems, bottomY, inner);
  const bottomH = systems.reduce((m, b) => Math.max(m, boxHeight(b)), 0);
  return { width: inner + MARGIN * 2, height: bottomY + bottomH + MARGIN, boxes: [...top, ...bottom] };
}

// The target row a rule's line ends on.
export function targetRowId(rule) {
  if (rule.targetType === 'OrgEntity') return `e:${rule.targetEntityType}|${NAME_ATTRIBUTE}`;
  return `s:${rule.targetType}|${lineField(rule)}`;
}

// A cubic from the side of the source box that faces the target to the side
// of the target box that faces the source, with horizontal handles.
export function linePath(sBox, sy, tBox, ty) {
  const rightward = tBox.x + tBox.w / 2 >= sBox.x + sBox.w / 2;
  const x1 = rightward ? sBox.x + sBox.w : sBox.x;
  const x2 = rightward ? tBox.x : tBox.x + tBox.w;
  const d = rightward ? 1 : -1;
  const h = Math.max(HANDLE_MIN, Math.abs(x2 - x1) / 2);
  const c1 = x1 + d * h;
  const c2 = x2 - d * h;
  return {
    path: `M ${x1} ${sy} C ${c1} ${sy} ${c2} ${ty} ${x2} ${ty}`,
    mid: { x: (x1 + 3 * c1 + 3 * c2 + x2) / 8, y: (sy + ty) / 2 },
  };
}

function lineName(rule) {
  const field = targetFieldLabel(rule.targetType, lineField(rule));
  return `Edit link ${rule.entityType} ${viaLabel(ruleVia(rule))} to ${targetTitle(rule.targetType, rule.targetEntityType)} ${field}`;
}

// One line per drawable rule ({ index } is the rule's index in `rules`); a
// rule whose source or target row is not on the canvas is left out (the list
// view under the canvas still shows it).
export function canvasLines(layout, rules, model) {
  const rows = new Map(layout.boxes.flatMap(b => b.rows.map(r => [r.id, { row: r, box: b }])));
  const lines = [];
  rules.forEach((rule, index) => {
    const from = rows.get(`e:${rule.entityType}|${ruleVia(rule)}`);
    const to = rows.get(targetRowId(rule));
    if (!from || !to || from.box === to.box) return;
    const { path, mid } = linePath(from.box, from.row.cy, to.box, to.row.cy);
    const label = lineLabel(rule, ruleCounts(model, rule));
    lines.push({ index, from: from.row.id, to: to.row.id, path, mid, label, name: lineName(rule), labelW: labelWidth(label) });
  });
  const ys = staggerLabels(lines.map(l => ({ x: l.mid.x, y: l.mid.y, w: l.labelW, h: LABEL_H, dir: 1 })));
  return lines.map((l, i) => ({ ...l, labelX: l.mid.x, labelY: ys[i] }));
}
