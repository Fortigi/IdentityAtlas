import { useCallback, useRef } from 'react';

// ─── A grid that scrolls with the page, its header always in view ────────
// The workbench grid has no vertical scrollbar of its own: the page scrolls, and
// the header rows stick to the top of the window (position: sticky against the
// page). A grid wider than its column still scrolls sideways inside itself — but
// a box that scrolls is what a sticky header sticks to, so the header lives in a
// strip of its own above the body: the same fixed column widths, clipped
// sideways (overflow-x: clip, not hidden, so the filter menus and popovers that
// open from it are not cut off), and moved with the body's horizontal scroll. Its
// cells marked data-sticky-left (the row labels) move back by the same amount, so
// they stay put as the body's sticky first column does. Set straight on the DOM:
// sideways scrolling re-renders nothing.
//
// `widths` are the columns' pixel widths, `head` the header rows, `children` the
// body rows; `label` names the grid (a region, its body the table).

export default function PageStickyTable({ label, widths, head, children, bodyRef: givenBodyRef }) {
  const headRef = useRef(null);
  const ownBodyRef = useRef(null);
  const bodyRef = givenBodyRef ?? ownBodyRef;
  const total = widths.reduce((a, w) => a + w, 0);

  const follow = useCallback(() => {
    const head = headRef.current;
    if (!head) return;
    const x = bodyRef.current?.scrollLeft ?? 0;
    head.style.transform = x ? `translateX(${-x}px)` : '';
    for (const el of head.querySelectorAll('[data-sticky-left]')) el.style.transform = x ? `translateX(${x}px)` : '';
  }, [bodyRef]);

  const cols = <colgroup>{widths.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>;
  const table = { className: 'border-separate border-spacing-0 text-xs', style: { tableLayout: 'fixed', width: total } };
  return (
    <div role="region" aria-label={label} className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="sticky top-0 z-20 rounded-t-lg bg-gray-50 dark:bg-gray-900" style={{ overflowX: 'clip' }} data-sticky-head>
        <table ref={headRef} {...table}>{cols}<thead>{head}</thead></table>
      </div>
      <div ref={bodyRef} onScroll={follow} className="overflow-x-auto">
        <table {...table} aria-label={label}>{cols}<tbody>{children}</tbody></table>
      </div>
    </div>
  );
}
