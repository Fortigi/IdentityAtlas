import { describe, it, expect } from 'vitest';
import { autoLayout, mergePositions, canvasBounds, MARGIN, GAP_X, GAP_Y, COLUMN_MAX } from './canvasLayout';
import { BOX_W, HEADER_H, ROW_H } from './modelCanvas';

const COL = BOX_W + GAP_X;
// A card with `rows` rows: height HEADER_H + rows·ROW_H.
const card = (id, owner, rows = 1, kind = 'entity') => ({ id, owner, kind, rows: Array.from({ length: rows }, (_, i) => ({ id: `${id}|${i}` })) });
const SYSTEMS = [card('s:Principal', null, 3, 'system'), card('s:Context', null, 1, 'system')];

describe('autoLayout', () => {
  it('puts the system cards in one column with the first list left of it and the second right', () => {
    const boxes = [card('e:A', 'Contoso hours', 2), card('e:B', 'Contoso hours', 1), card('e:C', 'Northwind staff', 1), ...SYSTEMS];
    const pos = autoLayout(boxes);
    // Left column at -COL, systems at 0, right column at +COL; shifted so the leftmost sits at the margin.
    expect(pos).toEqual({
      'e:A': { x: MARGIN, y: MARGIN },
      'e:B': { x: MARGIN, y: MARGIN + HEADER_H + 2 * ROW_H + GAP_Y },
      'e:C': { x: MARGIN + 2 * COL, y: MARGIN },
      's:Principal': { x: MARGIN + COL, y: MARGIN },
      's:Context': { x: MARGIN + COL, y: MARGIN + HEADER_H + 3 * ROW_H + GAP_Y },
    });
  });

  it('wraps a list after COLUMN_MAX cards into a further column on the same side, and the third list goes further left', () => {
    const many = Array.from({ length: COLUMN_MAX + 1 }, (_, i) => card(`e:H${i}`, 'Contoso hours'));
    const boxes = [...many, card('e:S', 'Northwind staff'), card('e:X', 'Third list'), card('e:O', null), ...SYSTEMS];
    const pos = autoLayout(boxes);
    const sys = pos['s:Principal'].x;
    expect(pos[`e:H${COLUMN_MAX - 1}`].x).toBe(sys - COL);
    expect(pos[`e:H${COLUMN_MAX}`]).toEqual({ x: sys - 2 * COL, y: MARGIN });
    expect(pos['e:S'].x).toBe(sys + COL);
    expect(pos['e:X'].x).toBe(sys - 3 * COL);
    // The types no list describes are the last group: right side, second column.
    expect(pos['e:O'].x).toBe(sys + 2 * COL);
    expect(Math.min(...Object.values(pos).map(p => p.x))).toBe(MARGIN);
  });

  it('lays out nothing for no cards', () => {
    expect(autoLayout([])).toEqual({});
  });
});

describe('mergePositions', () => {
  const boxes = [card('e:A', 'p', 2), card('e:B', 'p', 1), card('e:New', 'p', 1)];
  const auto = { 'e:A': { x: 24, y: 24 }, 'e:B': { x: 24, y: 200 }, 'e:New': { x: 24, y: 300 } };

  it('uses the automatic layout when nothing is saved', () => {
    expect(mergePositions(boxes, auto, {})).toEqual(auto);
    expect(mergePositions(boxes, auto, undefined)).toEqual(auto);
  });

  it('keeps a saved card where it was saved and moves a card the layout does not know below everything saved', () => {
    const saved = { 'e:A': { x: 500, y: 40 }, 'e:B': { x: 10, y: 400 }, 'e:Gone': { x: 1, y: 1 } };
    const merged = mergePositions(boxes, auto, saved);
    // e:B ends at 400 + 70 = 470; the new card starts two gaps under it.
    expect(merged).toEqual({ 'e:A': { x: 500, y: 40 }, 'e:B': { x: 10, y: 400 }, 'e:New': { x: 24, y: 470 + 2 * GAP_Y } });
  });

  it('ignores a saved position that is not a pair of numbers', () => {
    const merged = mergePositions(boxes, auto, { 'e:A': { x: 'left', y: 3 }, 'e:B': null });
    expect(merged).toEqual(auto);
  });

  it('uses only saved positions when every card has one', () => {
    const saved = { 'e:A': { x: 1, y: 2 }, 'e:B': { x: 3, y: 4 }, 'e:New': { x: 5, y: 6 } };
    expect(mergePositions(boxes, auto, saved)).toEqual(saved);
  });
});

describe('canvasBounds', () => {
  it('wraps every card with the margin', () => {
    const placed = [{ x: 100, y: 50, w: 200, h: 70 }, { x: -20, y: 300, w: 200, h: 96 }];
    expect(canvasBounds(placed)).toEqual({ x: -20 - MARGIN, y: 50 - MARGIN, w: 320 + 2 * MARGIN, h: 346 + 2 * MARGIN });
    expect(canvasBounds([])).toEqual({ x: 0, y: 0, w: 2 * MARGIN, h: 2 * MARGIN });
  });
});
