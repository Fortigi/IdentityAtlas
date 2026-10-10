// Organisation → Model → the model canvas: the pure geometry of ONE canvas for
// the whole model (a "model view" in the Power BI / Access sense: cards with
// one row per attribute, relations drawn from attribute row to field row).
//
//   entity cards  one per organisation entity type of EVERY import profile
//                 (newest version), owned by that profile: every attribute row
//                 is a source of a link rule, and the name row is also the
//                 target of another list's rule (targetType OrgEntity). A type
//                 the model has but no profile describes is drawn read-only
//                 from its attribute keys. Each card carries its profile as a
//                 chip (`owner`).
//                 Only COLLECTION types get a card: an enrichment is an
//                 attribute block on its target system card, an activity and a
//                 relation are edges (templateCanvas.js).
//   system cards  one per system target (Account, Person, Group/resource,
//                 Context) with a row per matchable field (all targets).
//
// Where a card stands is NOT decided here: placeBoxes takes a positions map
// (canvasLayout.js computes the automatic one, the saved one overrides it).
// A rule is a cubic line from its source row (rule.via) to its target row
// (lineField), leaving and entering the cards on their facing sides; a
// predicate (an organisation relation between two types) is a dashed line
// between the two card headers. Every number is a function of the input only.
import { NAME_ATTRIBUTE, entityAttributeNames, ruleVia } from './wizard/wizardDraft';
import { LABEL_H, labelWidth, staggerLabels } from './modelGraph';
import {
  SYSTEM_TARGETS, viaLabel, lineField, targetTitle, targetFieldLabel, ruleCounts, lineLabel,
} from './linkRulesDraft';
import { isCollectionTemplate } from './orgFormat';

export const BOX_W = 200;
export const HEADER_H = 44;
export const ROW_H = 26;
export const BLOCK_H = 22;
const HANDLE_MIN = 40;

function entityBox(type, attributes, count, profile) {
  const own = Boolean(profile);
  return {
    id: `e:${type}`, kind: 'entity', own, owner: profile?.name ?? null, profileId: profile?.id ?? null,
    title: type, entityType: type, count,
    rows: attributes.map(a => ({
      id: `e:${type}|${a}`, label: viaLabel(a), attribute: a, entityType: type, source: own,
      target: a === NAME_ATTRIBUTE ? { targetType: 'OrgEntity', targetEntityType: type, field: NAME_ATTRIBUTE } : null,
    })),
  };
}

function systemBox(s, count) {
  return {
    id: `s:${s.targetType}`, kind: 'system', own: false, owner: null, profileId: null,
    title: s.title, targetType: s.targetType, count,
    rows: s.fields.map(f => ({
      id: `s:${s.targetType}|${f}`, label: f, source: false, target: { targetType: s.targetType, field: f },
    })),
  };
}

// The cards of the whole model, before placement: the profiles' entity types
// in profile order (recipe order within one), then the types no profile
// describes (by name), then the system targets. A type two profiles both
// describe is one card, owned by the first.
const countsBy = (rows, key) => new Map((rows ?? []).map(r => [r[key], Number(r.count) || 0]));

function ownedBoxes(profiles, counts) {
  const boxes = [];
  const seen = new Set();
  for (const profile of profiles ?? []) {
    if (!isCollectionTemplate(profile?.recipe?.template)) continue;
    for (const e of profile?.recipe?.entities ?? []) {
      if (seen.has(e.type)) continue;
      seen.add(e.type);
      boxes.push(entityBox(e.type, entityAttributeNames(e), counts.get(e.type) ?? null, profile));
    }
  }
  return boxes;
}

// The types an enrichment, activity or relation profile describes: never a card.
function templateTypes(profiles) {
  return (profiles ?? []).filter(p => !isCollectionTemplate(p?.recipe?.template)).flatMap(({ recipe }) => [
    ...(recipe.entities ?? []).map(e => e.type), recipe.relation?.type, recipe.activity?.type,
  ]).filter(Boolean);
}

function orphanBoxes(entityTypes, owned, counts, skip) {
  const seen = new Set([...owned.map(b => b.entityType), ...skip]);
  return (entityTypes ?? [])
    .filter(t => !seen.has(t.type) && isCollectionTemplate(t.template))
    .sort((a, b) => a.type.localeCompare(b.type))
    .map(t => entityBox(t.type, [NAME_ATTRIBUTE, ...(t.attributeKeys ?? []).filter(k => k !== NAME_ATTRIBUTE)], counts.get(t.type) ?? null, null));
}

export function canvasBoxes(model) {
  const counts = countsBy(model?.entityTypes, 'type');
  const owned = ownedBoxes(model?.profiles, counts);
  const systemCounts = countsBy(model?.systemTypes, 'targetType');
  return [
    ...owned,
    ...orphanBoxes(model?.entityTypes, owned, counts, templateTypes(model?.profiles)),
    ...SYSTEM_TARGETS.map(s => systemBox(s, systemCounts.get(s.targetType) ?? null)),
  ];
}

// Every rule of every profile, with the profile it lives in and its index in
// that profile's (draft or saved) list: { key, profile, index, rule }.
export function ruleEntries(profiles, drafts = {}) {
  return (profiles ?? []).flatMap(p => (drafts[p.name] ?? p.linkRules ?? [])
    .map((rule, index) => ({ key: `${p.name}#${index}`, profile: p.name, index, rule })));
}

export const boxHeight = (box) => HEADER_H + box.rows.length * ROW_H + (box.blocks?.length ?? 0) * BLOCK_H;

// The cards at their positions ({ [id]: { x, y } }; a card without one sits
// at 0,0), with every row's own coordinates (cy = the row's middle).
export function placeBoxes(boxes, positions) {
  return boxes.map((b) => {
    const { x, y } = positions?.[b.id] ?? { x: 0, y: 0 };
    return {
      ...b, x, y, w: BOX_W, h: boxHeight(b),
      rows: b.rows.map((r, k) => {
        const ry = y + HEADER_H + k * ROW_H;
        return { ...r, boxId: b.id, boxTitle: b.title, x, y: ry, cy: ry + ROW_H / 2 };
      }),
      blocks: (b.blocks ?? []).map((k, i) => ({ ...k, x, y: y + HEADER_H + b.rows.length * ROW_H + i * BLOCK_H })),
    };
  });
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

export const withLabelYs = (lines) => {
  const ys = staggerLabels(lines.map(l => ({ x: l.mid.x, y: l.mid.y, w: l.labelW, h: LABEL_H, dir: 1 })));
  return lines.map((l, i) => ({ ...l, labelX: l.mid.x, labelY: ys[i] }));
};

// One line per drawable rule entry ({ key, profile, index } say which rule of
// which profile it is); a rule whose source or target row is not on the
// canvas is left out (the rule list under the canvas still shows it).
export function canvasLines(placed, entries, model) {
  const rows = new Map(placed.flatMap(b => b.rows.map(r => [r.id, { row: r, box: b }])));
  const lines = [];
  for (const { key, profile, index, rule } of entries) {
    const from = rows.get(`e:${rule.entityType}|${ruleVia(rule)}`);
    const to = rows.get(targetRowId(rule));
    if (!from || !to || from.box === to.box) continue;
    const { path, mid } = linePath(from.box, from.row.cy, to.box, to.row.cy);
    const label = lineLabel(rule, ruleCounts(model, rule));
    lines.push({ key, profile, index, from: from.row.id, to: to.row.id, path, mid, label, name: lineName(rule), labelW: labelWidth(label) });
  }
  return withLabelYs(lines);
}

// The organisation relations between two types (model.predicates), header to
// header; read-only (they come from the recipes' relations, not from rules).
// A relation of a type with itself is left to the overview diagram.
export function predicateLines(placed, model) {
  const boxes = new Map(placed.map(b => [b.id, b]));
  const lines = [];
  for (const p of model?.predicates ?? []) {
    const from = boxes.get(`e:${p.fromType}`);
    const to = boxes.get(`e:${p.toType}`);
    if (!from || !to || from === to) continue;
    const { path, mid } = linePath(from, from.y + HEADER_H / 2, to, to.y + HEADER_H / 2);
    const label = `${p.predicate} ${Number(p.count) || 0}`;
    lines.push({ key: `p:${p.fromType}:${p.predicate}:${p.toType}`, owners: [from.owner, to.owner], path, mid, label, labelW: labelWidth(label) });
  }
  return withLabelYs(lines);
}
