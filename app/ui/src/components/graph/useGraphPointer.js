import { useRef, useState } from 'react';

// Pan, zoom and node dragging for the relationship graph. Dragging the canvas
// pans it, the wheel zooms, dragging a node moves it (onMove) and dropping it
// pins it there (onPin). A pointer that travelled is a drag, not a click: the
// click that follows it is swallowed so a drop on a node does not also expand it.

const DRAG_THRESHOLD = 4;

export default function useGraphPointer({ viewBox, onMove, onPin }) {
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  // The node being dragged follows the pointer without the settle transition.
  const [dragging, setDragging] = useState(null);
  const svgRef = useRef(null);
  const drag = useRef(null);
  const swallowClick = useRef(false);

  // One CSS pixel in viewBox units.
  function unitsPerPixel() {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect?.width > 0 ? viewBox.width / rect.width : 1;
  }

  function begin(e, extra) {
    swallowClick.current = false;
    drag.current = { sx: e.clientX, sy: e.clientY, moved: false, ...extra };
  }

  function onCanvasPointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    begin(e, { mode: 'pan', ox: pan.x, oy: pan.y });
  }

  function onNodePointerDown(e, key, pos) {
    e.stopPropagation();
    begin(e, { mode: 'node', key, ox: pos.x, oy: pos.y, x: pos.x, y: pos.y });
  }

  function onPointerMove(e) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    d.moved = true;
    const k = unitsPerPixel();
    if (d.mode === 'pan') {
      setPan({ x: d.ox + dx * k, y: d.oy + dy * k });
      return;
    }
    if (dragging !== d.key) setDragging(d.key);
    d.x = Math.round(d.ox + (dx * k) / scale);
    d.y = Math.round(d.oy + (dy * k) / scale);
    onMove(d.key, d.x, d.y);
  }

  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (!d?.moved) return;
    swallowClick.current = true;
    if (d.mode === 'node') onPin(d.key, d.x, d.y);
  }

  function onClickCapture(e) {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  }

  function onWheel(e) {
    setScale(prev => Number(Math.max(0.3, Math.min(3, prev * (e.deltaY > 0 ? 0.9 : 1.1))).toFixed(2)));
  }

  function resetView() {
    setPan({ x: 0, y: 0 });
    setScale(1);
  }

  return {
    svgRef,
    pan,
    scale,
    dragging,
    dirty: pan.x !== 0 || pan.y !== 0 || scale !== 1,
    resetView,
    onNodePointerDown,
    canvasHandlers: {
      onPointerDown: onCanvasPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onPointerLeave: onPointerUp,
      onClickCapture,
      onWheel,
    },
  };
}
