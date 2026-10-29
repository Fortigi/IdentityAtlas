import { useEffect, useState } from 'react';

// Is the window wide enough for the workbench's grid and panel side by side
// (Tailwind's xl, 1280px)? Then the two share one row sized to the viewport and
// each scrolls inside it; narrower, they stack and the page scrolls — either way
// one vertical scrollbar, never the page's and the grid's together.
export const WIDE_QUERY = '(min-width: 1280px)';

const matches = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches;

export function useWideLayout() {
  const [wide, setWide] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return wide;
}
