// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@ui/test-utils/renderWithProviders';
import useViewportFitHeight, { measureAvailableHeight, MIN_USABLE_HEIGHT } from './useViewportFitHeight';

// Regression cover for the matrix double-scrollbar bug: the grid must be capped
// to the space that is REALLY left below it, never to a floor that is taller
// than that space (which is what put a second scrollbar on the page).

/**
 * Build a <main> + grid + <footer> layout with controllable geometry.
 * @param {{gridTop:number, viewport:number, footer:number, mainPad:string}} geo
 */
function layout({ gridTop = 300, viewport = 800, footer = 40, mainPad = '24px' } = {}) {
  document.body.innerHTML = `<main style="padding-bottom:${mainPad}"><div id="grid"></div></main><footer></footer>`;
  const grid = document.getElementById('grid');
  const foot = document.querySelector('footer');
  grid.getBoundingClientRect = () => ({ top: gridTop, bottom: gridTop, height: 0 });
  foot.getBoundingClientRect = () => ({ top: 0, bottom: footer, height: footer });
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(viewport);
  return grid;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.scrollY = 0;
  document.body.innerHTML = '';
});

describe('measureAvailableHeight', () => {
  it('returns null without an element', () => {
    expect(measureAvailableHeight(null)).toBeNull();
  });

  it('subtracts the footer and main’s bottom padding from the space below the grid', () => {
    const grid = layout({ gridTop: 300, viewport: 800, footer: 40, mainPad: '24px' });
    expect(measureAvailableHeight(grid)).toBe(800 - 300 - 40 - 24);
  });

  it('never returns more than the available space (no floor to overflow the page)', () => {
    // Tall chrome on a short viewport: only 36px left. A floor (the old code used
    // 160/240) would return more than that and push the page into a second
    // scrollbar.
    const grid = layout({ gridTop: 700, viewport: 800, footer: 40, mainPad: '24px' });
    expect(measureAvailableHeight(grid)).toBe(36);
  });

  it('clamps to zero when the chrome already fills the viewport', () => {
    const grid = layout({ gridTop: 900, viewport: 800 });
    expect(measureAvailableHeight(grid)).toBe(0);
  });

  it('measures the grid top document-relative so a scrolled page is not over-capped', () => {
    const grid = layout({ gridTop: 100, viewport: 800, footer: 40, mainPad: '24px' });
    window.scrollY = 200; // grid scrolled up: viewport-relative top would read 100
    expect(measureAvailableHeight(grid)).toBe(800 - 300 - 40 - 24);
  });

  it('copes with no footer and a non-numeric main padding', () => {
    document.body.innerHTML = '<main style="padding-bottom:auto"><div id="grid"></div></main>';
    const grid = document.getElementById('grid');
    grid.getBoundingClientRect = () => ({ top: 100 });
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
    expect(measureAvailableHeight(grid)).toBe(700);
  });

  // The resize grip lives below the grid. Forgetting it overflows the page by
  // exactly its height — the double scrollbar this whole hook exists to avoid.
  it('leaves room for whatever is laid out below the grid', () => {
    document.body.innerHTML = '<main style="padding-bottom:24px"><div id="wrap">'
      + '<div id="grid"></div><div id="grip"></div></div></main><footer></footer>';
    const grid = document.getElementById('grid');
    grid.getBoundingClientRect = () => ({ top: 300 });
    document.getElementById('grip').getBoundingClientRect = () => ({ height: 28 });
    document.querySelector('footer').getBoundingClientRect = () => ({ height: 40 });
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
    expect(measureAvailableHeight(grid)).toBe(800 - 300 - 40 - 24 - 28);
  });

  it('ignores siblings that are out of flow, hidden, or the footer itself', () => {
    document.body.innerHTML = '<main><div id="wrap"><div id="grid"></div>'
      + '<div id="modal" style="position:fixed"></div>'
      + '<div id="hidden" style="display:none"></div>'
      + '<footer id="inner"></footer></div></main>';
    const grid = document.getElementById('grid');
    grid.getBoundingClientRect = () => ({ top: 300 });
    for (const id of ['modal', 'hidden', 'inner']) {
      document.getElementById(id).getBoundingClientRect = () => ({ height: 100 });
    }
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
    expect(measureAvailableHeight(grid)).toBe(500 - 100); // only the <footer> subtraction
  });

  it('copes with an element outside a <main>', () => {
    document.body.innerHTML = '<div id="grid"></div>';
    const grid = document.getElementById('grid');
    grid.getBoundingClientRect = () => ({ top: 50 });
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(600);
    expect(measureAvailableHeight(grid)).toBe(550);
  });
});

describe('useViewportFitHeight', () => {
  it('caps the element to the measured space and re-measures on resize', () => {
    const grid = layout({ gridTop: 300, viewport: 800, footer: 40, mainPad: '24px' });
    const ref = { current: grid };
    const view = renderHook(() => useViewportFitHeight(ref, []));
    expect(view.result.current).toBe(436);

    // Viewport grows → the grid may grow with it.
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(1000);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(view.result.current).toBe(636);
  });

  it('re-measures when something above the grid changes size', () => {
    const observers = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    });
    const grid = layout({ gridTop: 300, viewport: 800, footer: 40, mainPad: '24px' });
    const ref = { current: grid };
    const view = renderHook(() => useViewportFitHeight(ref, []));
    expect(observers).toHaveLength(1);

    // A panel above the grid expands, pushing the grid down.
    grid.getBoundingClientRect = () => ({ top: 500 });
    act(() => { observers[0].cb(); });
    expect(view.result.current).toBe(236);

    view.unmount();
    expect(observers[0].disconnected).toBe(true);
  });

  it('stays null while there is no element to measure', () => {
    const view = renderHook(() => useViewportFitHeight({ current: null }, []));
    expect(view.result.current).toBeNull();
  });

  it('drops the cap when too little space is left, so the page scrolls instead', () => {
    // Tall chrome on a short viewport. Capping here would leave a grid a few
    // pixels high; not capping lets it render full height with the page as the
    // single scroller. Either way there is never a second scrollbar.
    const grid = layout({ gridTop: 700, viewport: 800, footer: 40, mainPad: '24px' });
    const view = renderHook(() => useViewportFitHeight({ current: grid }, []));
    expect(view.result.current).toBeNull();
  });

  it('caps again as soon as the space above is freed up', () => {
    const grid = layout({ gridTop: 700, viewport: 800, footer: 40, mainPad: '24px' });
    const view = renderHook(() => useViewportFitHeight({ current: grid }, []));
    expect(view.result.current).toBeNull();

    // A panel above the grid collapses (e.g. "How to read this matrix").
    grid.getBoundingClientRect = () => ({ top: 300 });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(view.result.current).toBe(436);
  });

  it('caps at exactly the usable minimum', () => {
    const viewport = MIN_USABLE_HEIGHT + 364;
    const grid = layout({ gridTop: 300, viewport, footer: 40, mainPad: '24px' });
    const view = renderHook(() => useViewportFitHeight({ current: grid }, []));
    expect(view.result.current).toBe(MIN_USABLE_HEIGHT);
  });
});
