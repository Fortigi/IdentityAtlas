// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@ui/test-utils/renderWithProviders';
import useResizableGridHeight, {
  HEIGHT_STORAGE_KEY, MAX_GRID_HEIGHT, clampGridHeight, readStoredHeight,
} from './useResizableGridHeight';
import { MIN_USABLE_HEIGHT } from './useViewportFitHeight';

// Requestor feedback on #370: how much of the window the matrix gets is the
// analyst's call, not something we can measure for them. The measured fit stays
// the default; dragging the grip overrides it and is remembered.

/** Layout with a grid whose measured fit is `viewport - gridTop`. */
function layout({ gridTop = 300, viewport = 800, rendered = 0 } = {}) {
  document.body.innerHTML = '<main><div id="grid"></div></main>';
  const grid = document.getElementById('grid');
  grid.getBoundingClientRect = () => ({ top: gridTop, height: rendered });
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(viewport);
  return { current: grid };
}

const drag = (from, to) => {
  const move = new Event('pointermove');
  move.clientY = to;
  window.dispatchEvent(move);
  return from;
};

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('clampGridHeight / readStoredHeight', () => {
  it('never allows a grid smaller than a usable one, or an unreachable page', () => {
    expect(clampGridHeight(10)).toBe(MIN_USABLE_HEIGHT);
    expect(clampGridHeight(MAX_GRID_HEIGHT + 5000)).toBe(MAX_GRID_HEIGHT);
    expect(clampGridHeight(420.4)).toBe(420);
  });

  it('ignores a missing or unusable stored value', () => {
    expect(readStoredHeight(HEIGHT_STORAGE_KEY)).toBeNull();
    localStorage.setItem(HEIGHT_STORAGE_KEY, 'not-a-number');
    expect(readStoredHeight(HEIGHT_STORAGE_KEY)).toBeNull();
    localStorage.setItem(HEIGHT_STORAGE_KEY, '640');
    expect(readStoredHeight(HEIGHT_STORAGE_KEY)).toBe(640);
  });

  it('survives storage being unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readStoredHeight(HEIGHT_STORAGE_KEY)).toBeNull();
  });
});

describe('useResizableGridHeight', () => {
  it('falls back to the measured fit while the analyst has not chosen a height', () => {
    const ref = layout({ gridTop: 300, viewport: 800 });
    const view = renderHook(() => useResizableGridHeight(ref, []));
    expect(view.result.current.height).toBe(500);
    expect(view.result.current.isCustom).toBe(false);
  });

  it('opens at the height chosen last time', () => {
    localStorage.setItem(HEIGHT_STORAGE_KEY, '720');
    const ref = layout({ gridTop: 300, viewport: 800 });
    const view = renderHook(() => useResizableGridHeight(ref, []));
    expect(view.result.current.height).toBe(720);
    expect(view.result.current.isCustom).toBe(true);
  });

  it('grows and shrinks by dragging, and remembers where the drag ended', () => {
    const ref = layout({ gridTop: 300, viewport: 800 });
    const view = renderHook(() => useResizableGridHeight(ref, []));

    act(() => { view.result.current.startDrag(400); });
    act(() => { drag(400, 550); });                 // 150px further down
    expect(view.result.current.height).toBe(650);
    expect(localStorage.getItem(HEIGHT_STORAGE_KEY)).toBe('650');

    act(() => { drag(400, 350); });                 // back up past the start
    expect(view.result.current.height).toBe(450);

    act(() => { window.dispatchEvent(new Event('pointerup')); });
    act(() => { drag(400, 900); });                 // released — no longer tracking
    expect(view.result.current.height).toBe(450);
  });

  it('starts a drag from the height the grid is actually rendering at', () => {
    const ref = layout({ gridTop: 300, viewport: 800, rendered: 240 });
    const view = renderHook(() => useResizableGridHeight(ref, []));
    act(() => { view.result.current.startDrag(100); });
    act(() => { drag(100, 160); });
    expect(view.result.current.height).toBe(300);
  });

  it('resizes by keyboard steps and hands the height back on reset', () => {
    const ref = layout({ gridTop: 300, viewport: 800 });
    const view = renderHook(() => useResizableGridHeight(ref, []));

    act(() => { view.result.current.resizeBy(100); });
    expect(view.result.current.height).toBe(600);
    act(() => { view.result.current.resizeBy(-250); });
    expect(view.result.current.height).toBe(350);

    act(() => { view.result.current.reset(); });
    expect(view.result.current.height).toBe(500);   // back to the measured fit
    expect(view.result.current.isCustom).toBe(false);
    expect(localStorage.getItem(HEIGHT_STORAGE_KEY)).toBeNull();
  });

  it('will not let a drag shrink the grid below a usable one', () => {
    const ref = layout({ gridTop: 300, viewport: 800 });
    const view = renderHook(() => useResizableGridHeight(ref, []));
    act(() => { view.result.current.startDrag(400); });
    act(() => { drag(400, -2000); });
    expect(view.result.current.height).toBe(MIN_USABLE_HEIGHT);
  });

  it('keeps the chosen height even when storage refuses to remember it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const ref = layout({ gridTop: 300, viewport: 800 });
    const view = renderHook(() => useResizableGridHeight(ref, []));
    act(() => { view.result.current.resizeBy(120); });
    expect(view.result.current.height).toBe(620);
  });

  it('stops listening for the drag when the matrix goes away mid-drag', () => {
    const ref = layout({ gridTop: 300, viewport: 800 });
    const view = renderHook(() => useResizableGridHeight(ref, []));
    const removed = vi.spyOn(window, 'removeEventListener');
    act(() => { view.result.current.startDrag(400); });
    view.unmount();
    expect(removed.mock.calls.map(c => c[0])).toEqual(
      expect.arrayContaining(['pointermove', 'pointerup', 'pointercancel']),
    );
  });

  it('drops a half-finished drag when a new one starts', () => {
    const ref = layout({ gridTop: 300, viewport: 800 });
    const view = renderHook(() => useResizableGridHeight(ref, []));
    act(() => { view.result.current.startDrag(400); });
    act(() => { view.result.current.startDrag(100); });
    act(() => { drag(100, 150); });
    expect(view.result.current.height).toBe(550); // one 50px move, not two
  });
});
