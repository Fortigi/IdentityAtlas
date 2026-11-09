import { useLayoutEffect, useReducer } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';

// Rows virtualised against the page's scroll (the workbench grid has no
// vertical scrollbar of its own — PageStickyTable): only the rows near the window
// are rendered, the rest are a spacer above and below. `bodyRef` is the grid's
// body; how far down the page it starts (scrollMargin) is measured after each
// layout, since what sits above it (a selection bar, a filter strip) comes and goes.
//
// Returns the rows to render (each with its `index`) and the spacer heights.

const keep = (prev, next) => (Math.abs(prev - next) < 1 ? prev : next);

export function usePageVirtualRows(bodyRef, count, rowHeight) {
  const [scrollMargin, setScrollMargin] = useReducer(keep, 0);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) setScrollMargin(el.getBoundingClientRect().top + window.scrollY);
  });
  const virtualizer = useWindowVirtualizer({ count, estimateSize: () => rowHeight, overscan: 20, scrollMargin });
  const items = virtualizer.getVirtualItems();
  const first = items[0];
  const last = items[items.length - 1];
  return {
    items,
    padTop: first ? first.start - scrollMargin : 0,
    padBottom: last ? virtualizer.getTotalSize() - (last.end - scrollMargin) : 0,
  };
}
