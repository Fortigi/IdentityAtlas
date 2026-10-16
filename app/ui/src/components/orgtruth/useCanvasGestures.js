// Organisation → Model → the model canvas: pointer gestures (mouse, pen and
// touch alike) and wheel zoom on the canvas SVG.
//
//   const g = useCanvasGestures({ placed, positions, canConnect, onMove, onMoveEnd, onConnect });
//   <svg ref={g.svgRef} {...g.handlers}> <g transform={…g.view…}> … </g> </svg>
//
// What a press starts depends on what it lands on:
//   [data-drag="box"]  (a card header)        drag the card: onMove(id, pos) live,
//                                               onMoveEnd() on release
//   [data-drag="row"]  (a source row, editor)  draw a relation: a ghost line follows
//                                               the pointer; released on a row,
//                                               onConnect(sourceRow, targetRow)
//   [data-nodrag]      (pencil, rename field)  nothing
//   anything else      (the background)        pan the view
// A press that travels less than DRAG_SLOP stays a click (row selection,
// line editing), so the click-a-row-then-a-field flow keeps working. The
// pointer is captured only once a drag really starts. The math lives in
// canvasView.js.
import { useCallback, useEffect, useRef, useState } from 'react';
import { BOX_W } from './modelCanvas';
import { IDENTITY, toWorld, zoomAt, fitView, dragged, beyondSlop, rowAt } from './canvasView';

const WHEEL_STEP = 0.0015;

function pointIn(svg, e) {
  const r = svg?.getBoundingClientRect?.();
  return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
}

// Keep receiving the moves when the pointer leaves the SVG; a pointer the
// browser no longer tracks (or an environment without capture) just isn't captured.
function capture(svg, pointerId) {
  try { svg?.setPointerCapture?.(pointerId); } catch { /* not capturable: the drag still works inside the SVG */ }
}

const sizeOf = (svg) => svg?.getBoundingClientRect?.() ?? { width: 0, height: 0 };

// What the press at `target` grabs: { kind: 'box', id } | { kind: 'row', row } | { kind: 'pan' } | null.
function grabbed(target, placed, canConnect) {
  if (target?.closest?.('[data-nodrag]')) return null;
  const handle = target?.closest?.('[data-drag]');
  const kind = handle?.getAttribute('data-drag');
  if (kind === 'box') return { kind, id: handle.closest('[data-box]').getAttribute('data-box') };
  if (kind === 'row' && canConnect) {
    const id = handle.getAttribute('data-row');
    const row = placed.flatMap(b => b.rows).find(r => r.id === id);
    if (row?.source) return { kind, row };
  }
  return { kind: 'pan' };
}

// Where the grabbed thing starts: the card's position, the source row's right
// edge (where the ghost line leaves), or the view itself.
function originOf(grab, positions, view) {
  if (grab.kind === 'box') return positions[grab.id] ?? { x: 0, y: 0 };
  if (grab.kind === 'row') return { x: grab.row.x + BOX_W, y: grab.row.cy };
  return view;
}

export function useCanvasGestures({ placed, positions, canConnect, onMove, onMoveEnd, onConnect }) {
  // A callback ref (state, not useRef): the SVG mounts after the layout has
  // loaded, and the wheel listener must follow it.
  const [svg, svgRef] = useState(null);
  const gesture = useRef(null);
  const [view, setView] = useState(IDENTITY);
  const [ghost, setGhost] = useState(null);

  useEffect(() => {
    if (!svg) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const p = pointIn(svg, e);
      setView(v => zoomAt(v, Math.exp(-e.deltaY * WHEEL_STEP), p.x, p.y));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [svg]);

  const onPointerDown = (e) => {
    if (e.button > 0) return;
    const grab = grabbed(e.target, placed, canConnect);
    if (!grab) return;
    const start = pointIn(svg, e);
    gesture.current = { ...grab, start, origin: originOf(grab, positions, view), view, moved: false };
  };

  const onPointerMove = (e) => {
    const g = gesture.current;
    if (!g) return;
    const now = pointIn(svg, e);
    if (!g.moved) {
      if (!beyondSlop(g.start, now)) return;
      g.moved = true;
      capture(svg, e.pointerId);
    }
    if (g.kind === 'pan') setView({ ...g.view, ...dragged(g.origin, g.start, now) });
    if (g.kind === 'box') onMove(g.id, dragged(g.origin, g.start, now, g.view.k));
    if (g.kind === 'row') setGhost({ from: g.origin, to: toWorld(g.view, now.x, now.y) });
  };

  const onPointerUp = (e) => {
    const g = gesture.current;
    gesture.current = null;
    setGhost(null);
    if (!g?.moved) return;
    if (g.kind === 'box') onMoveEnd();
    if (g.kind === 'row') {
      const now = pointIn(svg, e);
      const target = rowAt(placed, toWorld(g.view, now.x, now.y));
      if (target) onConnect(g.row, target);
    }
  };

  const onPointerCancel = () => { gesture.current = null; setGhost(null); };

  const zoomBy = useCallback((factor) => {
    const r = sizeOf(svg);
    setView(v => zoomAt(v, factor, r.width / 2, r.height / 2));
  }, [svg]);
  const fit = useCallback((bounds) => {
    const r = sizeOf(svg);
    setView(fitView(bounds, r.width, r.height));
  }, [svg]);

  return {
    svgRef, view, ghost, zoomBy, fit,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
