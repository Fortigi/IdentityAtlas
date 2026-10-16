import { describe, it, expect } from 'vitest';
import {
  toWorld, zoomAt, fitView, dragged, beyondSlop, rowAt, clampZoom, MIN_ZOOM, MAX_ZOOM, DRAG_SLOP, IDENTITY,
} from './canvasView';
import { placeBoxes } from './modelCanvas';

describe('toWorld and zoomAt', () => {
  it('converts a pointer point to canvas units through pan and zoom', () => {
    expect(toWorld({ x: 100, y: 50, k: 2 }, 300, 250)).toEqual({ x: 100, y: 100 });
    expect(toWorld(IDENTITY, 7, 9)).toEqual({ x: 7, y: 9 });
  });

  it('keeps the canvas point under the pointer still while zooming', () => {
    const view = { x: 40, y: 10, k: 1 };
    const next = zoomAt(view, 2, 140, 110);
    expect(next).toEqual({ x: -60, y: -90, k: 2 });
    expect(toWorld(next, 140, 110)).toEqual(toWorld(view, 140, 110));
  });

  it('clamps the zoom at both ends', () => {
    expect(zoomAt({ x: 0, y: 0, k: 2 }, 10, 0, 0).k).toBe(MAX_ZOOM);
    expect(zoomAt({ x: 0, y: 0, k: 0.5 }, 0.1, 0, 0).k).toBe(MIN_ZOOM);
    expect(clampZoom(1.1)).toBe(1.1);
  });
});

describe('fitView', () => {
  it('scales a large canvas down and centres it', () => {
    expect(fitView({ x: -24, y: -24, w: 2000, h: 500 }, 1000, 600)).toEqual({ x: 12, y: 187, k: 0.5 });
  });

  it('never zooms in above 100 %, and centres a small canvas', () => {
    expect(fitView({ x: 0, y: 0, w: 200, h: 100 }, 1000, 600)).toEqual({ x: 400, y: 250, k: 1 });
  });

  it('keeps the identity view when the SVG has no size yet', () => {
    expect(fitView({ x: 0, y: 0, w: 200, h: 100 }, 0, 600)).toEqual(IDENTITY);
    expect(fitView({ x: 0, y: 0, w: 200, h: 100 }, 800, undefined)).toEqual(IDENTITY);
  });
});

describe('dragged and beyondSlop', () => {
  it('moves by the pointer delta, divided by the zoom for a card', () => {
    expect(dragged({ x: 100, y: 100 }, { x: 10, y: 10 }, { x: 70, y: -30 })).toEqual({ x: 160, y: 60 });
    expect(dragged({ x: 100, y: 100 }, { x: 10, y: 10 }, { x: 70, y: -30 }, 2)).toEqual({ x: 130, y: 80 });
    expect(dragged({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, 3)).toEqual({ x: 0, y: 0 });
  });

  it('counts a press as a drag from DRAG_SLOP pixels on', () => {
    expect(beyondSlop({ x: 0, y: 0 }, { x: DRAG_SLOP - 1, y: 0 })).toBe(false);
    expect(beyondSlop({ x: 0, y: 0 }, { x: 0, y: DRAG_SLOP })).toBe(true);
    expect(beyondSlop({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(true);
  });
});

describe('rowAt', () => {
  const card = (id, rows) => ({ id, kind: 'entity', rows: rows.map(r => ({ id: `${id}|${r}` })) });
  // A at 0,0 (rows at y 44..70, 70..96), B overlapping it at 100,50 and drawn on top.
  const placed = placeBoxes([card('e:A', ['name', 'owner']), card('e:B', ['name'])], { 'e:A': { x: 0, y: 0 }, 'e:B': { x: 100, y: 50 } });

  it('finds the row under the point, the row boundary belonging to the lower row', () => {
    expect(rowAt(placed, { x: 10, y: 44 }).id).toBe('e:A|name');
    expect(rowAt(placed, { x: 10, y: 69.9 }).id).toBe('e:A|name');
    expect(rowAt(placed, { x: 10, y: 70 }).id).toBe('e:A|owner');
  });

  it('lets the card drawn last win where two cards overlap', () => {
    expect(rowAt(placed, { x: 150, y: 95 }).id).toBe('e:B|name');
    expect(rowAt(placed, { x: 99, y: 95 }).id).toBe('e:A|owner');
  });

  it('returns null on a header, outside every card, or on an empty canvas', () => {
    expect(rowAt(placed, { x: 10, y: 20 })).toBeNull();
    expect(rowAt(placed, { x: 500, y: 500 })).toBeNull();
    expect(rowAt([], { x: 0, y: 0 })).toBeNull();
  });
});
