import { useLayoutEffect, useState } from 'react';

// Cap a scroll container to the viewport space that is actually left below it,
// so ONLY that container scrolls and the page never gets a second scrollbar.
//
// The matrix grids used to guess the chrome height with a fixed
// `max-h-[calc(100vh-280px)]`. The real chrome (auth banner + scope statistics +
// "How to read this matrix") is taller than the guess, so the grid was too tall
// and the page scrolled next to the grid's own scrollbar. Everything here is
// measured instead of guessed — including the space the layout still needs
// *below* the grid.

// Below this many pixels a capped grid is no longer a grid — one header row and
// a sliver of data. When that little is left (tall chrome on a short viewport)
// the cap is dropped entirely: the grid renders at its natural height and the
// PAGE scrolls. Either way exactly one scrollbar is in play — capping to a
// floor taller than the available space is what produced two.
export const MIN_USABLE_HEIGHT = 200;

/**
 * Space left for `el` between its top edge and the bottom of the viewport,
 * minus the app footer and the bottom padding of the <main> it lives in.
 * Returns null when there is nothing to measure.
 */
export function measureAvailableHeight(el) {
  if (!el) return null;
  const doc = el.ownerDocument || document;
  const win = doc.defaultView || window;

  // What still has to fit underneath the container.
  const footer = doc.querySelector('footer');
  const footerH = footer ? footer.getBoundingClientRect().height : 0;
  const main = typeof el.closest === 'function' ? el.closest('main') : null;
  const mainPad = main ? parseFloat(win.getComputedStyle(main).paddingBottom) : 0;

  // clientHeight is the real layout height. getBoundingClientRect().top is
  // viewport-relative, so on a scrolled page it reads too small and would cap
  // the container too tall — a self-sustaining overflow. scrollY makes it
  // document-relative.
  const top = el.getBoundingClientRect().top + win.scrollY;

  // Never rounded up to a floor: a cap taller than the space available is the
  // page overflow this exists to prevent (a 240px floor with 200px of room
  // overflows the page by 40px).
  return Math.max(0, doc.documentElement.clientHeight - top - footerH - (Number.isFinite(mainPad) ? mainPad : 0));
}

/**
 * Measured max-height (px) for the element in `ref`, kept up to date on resize
 * and on any layout change above it (header content loads late, panels toggle).
 *
 * Returns null when the element should not be capped at all — before the first
 * measurement, and when less than MIN_USABLE_HEIGHT is left. Collapsing a panel
 * above the grid re-measures and hands the space straight back.
 *
 * @param {{current: HTMLElement|null}} ref  the scroll container
 * @param {Array} deps                       extra re-measure triggers
 * @returns {number|null} px cap, or null for "do not cap"
 */
export default function useViewportFitHeight(ref, deps = []) {
  const [maxHeight, setMaxHeight] = useState(null);

  useLayoutEffect(() => {
    const measure = () => {
      const h = measureAvailableHeight(ref.current);
      if (h !== null) setMaxHeight(h >= MIN_USABLE_HEIGHT ? h : null);
    };
    measure();
    // The first paint can land before late chrome (banners, stats) is laid out.
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure); // body: anything above the grid shifts it down
      ro.observe(document.body);
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      if (ro) ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return maxHeight;
}
