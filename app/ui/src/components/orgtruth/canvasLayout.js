// Organisation → Model → the model canvas: where the cards stand.
//
//   autoLayout      the automatic arrangement: the system cards in one column
//                   in the middle, each profile's cards in their own column(s)
//                   around it — first profile left, second right, third
//                   further left, … — at most COLUMN_MAX cards per column, the
//                   types no profile describes as the last group.
//   mergePositions  the saved positions over the automatic ones. A card the
//                   saved layout does not know yet (a new list, a renamed
//                   type) keeps its automatic place, shifted below everything
//                   that was saved so it never lands on top of a placed card.
//   canvasBounds    the box around every placed card.
//
// Positions are { [cardId]: { x, y } } with whole-pixel numbers; every number
// is a function of the input only.
import { BOX_W, boxHeight } from './modelCanvas';

export const MARGIN = 24;
export const GAP_X = 120;
export const GAP_Y = 32;
export const COLUMN_MAX = 4;
const COL_W = BOX_W + GAP_X;

function groupsOf(boxes) {
  const groups = new Map();
  for (const b of boxes) {
    if (b.kind === 'system') continue;
    const key = b.owner ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  return [...groups.values()];
}

function stack(boxes, x, out) {
  let y = 0;
  for (const b of boxes) {
    out[b.id] = { x, y };
    y += boxHeight(b) + GAP_Y;
  }
}

function shift(positions, dx, dy) {
  return Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }]));
}

const minOf = (positions, axis) => Math.min(...Object.values(positions).map(p => p[axis]));

export function autoLayout(boxes) {
  const raw = {};
  stack(boxes.filter(b => b.kind === 'system'), 0, raw);
  const nextColumn = { [-1]: 1, 1: 1 };
  groupsOf(boxes).forEach((group, g) => {
    const side = g % 2 === 0 ? -1 : 1;
    for (let i = 0; i < group.length; i += COLUMN_MAX) {
      stack(group.slice(i, i + COLUMN_MAX), side * nextColumn[side] * COL_W, raw);
      nextColumn[side] += 1;
    }
  });
  if (Object.keys(raw).length === 0) return {};
  return shift(raw, MARGIN - minOf(raw, 'x'), MARGIN - minOf(raw, 'y'));
}

const isPos = (p) => p != null && Number.isFinite(p.x) && Number.isFinite(p.y);

export function mergePositions(boxes, auto, saved) {
  const placed = {};
  const fresh = {};
  for (const b of boxes) {
    if (isPos(saved?.[b.id])) placed[b.id] = saved[b.id];
    else if (auto[b.id]) fresh[b.id] = auto[b.id];
  }
  if (Object.keys(placed).length === 0 || Object.keys(fresh).length === 0) return { ...placed, ...fresh };
  const bottom = Math.max(...boxes.filter(b => placed[b.id]).map(b => placed[b.id].y + boxHeight(b)));
  return { ...placed, ...shift(fresh, 0, bottom + GAP_Y * 2 - minOf(fresh, 'y')) };
}

// { x, y, w, h } of the placed cards (with the margin around them); an empty
// canvas is one margin square.
export function canvasBounds(placed) {
  if (placed.length === 0) return { x: 0, y: 0, w: MARGIN * 2, h: MARGIN * 2 };
  const x0 = Math.min(...placed.map(b => b.x));
  const y0 = Math.min(...placed.map(b => b.y));
  const x1 = Math.max(...placed.map(b => b.x + b.w));
  const y1 = Math.max(...placed.map(b => b.y + b.h));
  return { x: x0 - MARGIN, y: y0 - MARGIN, w: x1 - x0 + MARGIN * 2, h: y1 - y0 + MARGIN * 2 };
}
