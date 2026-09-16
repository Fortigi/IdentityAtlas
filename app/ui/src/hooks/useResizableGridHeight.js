import { useCallback, useEffect, useRef, useState } from 'react';
import useViewportFitHeight, { MIN_USABLE_HEIGHT } from './useViewportFitHeight';

// How tall the matrix grid is. Two answers, in this order:
//
//   1. the height the analyst dragged it to, remembered across sessions;
//   2. otherwise the measured "fit the rest of the window" height that
//      useViewportFitHeight works out (which is also what the reset goes back
//      to).
//
// The measured fit is a good default but only a default: a matrix is read
// alongside the panels above it, and how much of the window each deserves is a
// judgement call the analyst makes, not one we can measure (requestor feedback
// on #370). Dragging never disables the measuring hook — it only overrides it —
// so "Fit to window" always has something to go back to.

export const HEIGHT_STORAGE_KEY = 'fgraph-matrix-height';

// One arrow-key press. Roughly four matrix rows, so the keyboard path is usable
// without being unbearably slow over a full window.
export const RESIZE_STEP = 100;

// Guards a stored/dragged value: never smaller than a grid that still shows
// something, never so tall that a stray drag leaves an unreachable page.
export const MAX_GRID_HEIGHT = 10000;

export const clampGridHeight = (px) =>
  Math.min(MAX_GRID_HEIGHT, Math.max(MIN_USABLE_HEIGHT, Math.round(px)));

export function readStoredHeight(storageKey = HEIGHT_STORAGE_KEY) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? clampGridHeight(n) : null;
  } catch {
    return null; // storage disabled (private mode) — fall back to the fit
  }
}

function writeStoredHeight(storageKey, value) {
  try {
    if (value == null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, String(value));
  } catch { /* storage disabled — the height still applies for this session */ }
}

/**
 * Height (px) for the grid in `ref`, resizable by the user and persisted.
 *
 * @param {{current: HTMLElement|null}} ref  the scroll container
 * @param {Array} deps                       extra re-measure triggers, as for useViewportFitHeight
 * @param {string} storageKey                where the chosen height is remembered
 * @returns {{height: number|null, isCustom: boolean, startDrag: (clientY:number)=>void,
 *            resizeBy: (delta:number)=>void, reset: ()=>void}}
 */
export default function useResizableGridHeight(ref, deps = [], storageKey = HEIGHT_STORAGE_KEY) {
  const fitHeight = useViewportFitHeight(ref, deps);
  const [custom, setCustom] = useState(() => readStoredHeight(storageKey));

  // Torn down on unmount so a drag that is still in progress can't keep
  // listening on the window.
  const endDragRef = useRef(null);
  useEffect(() => () => endDragRef.current?.(), []);

  const apply = useCallback((next) => {
    const value = next == null ? null : clampGridHeight(next);
    setCustom(value);
    writeStoredHeight(storageKey, value);
  }, [storageKey]);

  // What a resize starts from: the chosen height, else whatever the grid is
  // actually rendering at right now, else the fit it is about to be given (a
  // zero rect means "not laid out yet", not "zero pixels tall").
  const currentHeight = useCallback(() => {
    if (custom != null) return custom;
    const rendered = ref.current?.getBoundingClientRect?.().height || 0;
    return rendered > 0 ? rendered : (fitHeight ?? MIN_USABLE_HEIGHT);
  }, [custom, fitHeight, ref]);

  const resizeBy = useCallback((delta) => apply(currentHeight() + delta), [apply, currentHeight]);
  const reset = useCallback(() => apply(null), [apply]);

  const startDrag = useCallback((clientY) => {
    endDragRef.current?.();
    const startHeight = currentHeight();
    const onMove = (e) => apply(startHeight + (e.clientY - clientY));
    const end = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      endDragRef.current = null;
    };
    endDragRef.current = end;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }, [apply, currentHeight]);

  return { height: custom ?? fitHeight, isCustom: custom != null, startDrag, resizeBy, reset };
}
