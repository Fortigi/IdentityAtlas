// Organisation → Model → the model canvas: pan, zoom, drag and hit-testing,
// as pure functions of a view { x, y, k } (screen = world * k + (x, y)).
//
//   toWorld     a point on the SVG (pixels from its top-left) in canvas units
//   zoomAt      zoom by a factor, keeping the canvas point under the pointer still
//   fitView     the view that shows a bounds box whole, centred, never above 100 %
//   dragged     where a dragged card (or the panned view) is after the pointer
//               moved from `start` to `now`: the delta, divided by the zoom for a card
//   rowAt       the card row under a canvas point (the topmost card wins)
//   beyondSlop  whether a pointer travelled far enough to count as a drag rather
//               than a click
import { ROW_H } from './modelCanvas';

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;
export const DRAG_SLOP = 4;
export const IDENTITY = Object.freeze({ x: 0, y: 0, k: 1 });

export const clampZoom = (k) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

export function toWorld(view, px, py) {
  return { x: (px - view.x) / view.k, y: (py - view.y) / view.k };
}

export function zoomAt(view, factor, px, py) {
  const k = clampZoom(view.k * factor);
  const r = k / view.k;
  return { x: px - (px - view.x) * r, y: py - (py - view.y) * r, k };
}

export function fitView(bounds, width, height) {
  if (!(width > 0) || !(height > 0)) return { ...IDENTITY };
  const k = clampZoom(Math.min(1, width / bounds.w, height / bounds.h));
  return {
    x: (width - bounds.w * k) / 2 - bounds.x * k,
    y: (height - bounds.h * k) / 2 - bounds.y * k,
    k,
  };
}

export const beyondSlop = (start, now) => Math.hypot(now.x - start.x, now.y - start.y) >= DRAG_SLOP;

// origin: the card's (or the view's) position when the drag started; scale:
// the zoom for a card (pointer pixels → canvas units), 1 for the view itself.
export function dragged(origin, start, now, scale = 1) {
  return {
    x: Math.round(origin.x + (now.x - start.x) / scale),
    y: Math.round(origin.y + (now.y - start.y) / scale),
  };
}

const inside = (b, p) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

export function rowAt(placed, point) {
  for (let i = placed.length - 1; i >= 0; i--) {
    const box = placed[i];
    if (!inside(box, point)) continue;
    return box.rows.find(r => point.y >= r.y && point.y < r.y + ROW_H) ?? null;
  }
  return null;
}
