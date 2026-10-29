import { useRef } from 'react';
import useViewportFitHeight from '@ui/hooks/useViewportFitHeight';
import { useWideLayout } from './useWideLayout';
import { Legend } from './WorkbenchControls';

// ─── The grid and the candidate panel: one scroll container, never two ───
// As the global matrix does (useViewportFitHeight): with room for both side by
// side (xl), the row is sized to the rest of the window — the grid scrolls
// inside it with its header rows sticky, and the panel scrolls on its own beside
// it; the page itself does not scroll. Narrower (stacked), or when the window
// leaves too little room for a grid worth the name, nothing is capped and the
// page alone scrolls. Either way one vertical scrollbar for the grid.
//
// `grid(fill)` renders the grid; `fill` says it must fill the height it is given.
// `deps` re-measure when the chrome above changes height (a selection bar, a strip).

// Below this the grid would show little more than its header rows (people's
// attributes stack up above the access), so the page scrolls instead.
export const MIN_GRID_ROW_HEIGHT = 360;

export default function GridAndPanel({ grid, panel, deps }) {
  const ref = useRef(null);
  const wide = useWideLayout();
  const fit = useViewportFitHeight(ref, deps);
  const fixed = wide && fit != null && fit >= MIN_GRID_ROW_HEIGHT;
  return (
    <div ref={ref} data-fit={fixed ? 'viewport' : 'page'} className="flex flex-col gap-3 xl:flex-row" style={fixed ? { height: fit } : undefined}>
      <div className={`flex min-w-0 flex-1 flex-col gap-2 ${fixed ? 'min-h-0' : ''}`}>
        {grid(fixed)}
        <div className="shrink-0"><Legend /></div>
      </div>
      <div className={`w-full shrink-0 xl:w-96 ${fixed ? 'min-h-0 overflow-y-auto' : ''}`} data-testid="workbench-panel">
        {panel}
      </div>
    </div>
  );
}
