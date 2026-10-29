import { Legend } from './WorkbenchControls';

// ─── The grid and the candidate panel: the page scrolls, nothing else ────
// One vertical scrollbar, the page's: the grid has none of its own — its header
// rows stick to the top of the window as the page scrolls (PageStickyTable) — and
// a wide grid scrolls only sideways, inside itself. Beside it (xl) the candidate
// panel sticks to the top of the window too, and scrolls within itself only when
// it is taller than the window. Narrower, the two stack.
// (Decided with Wim 2026-10-29: the page's scrollbar, not the grid's; an earlier
// grid sized to the window left room for one row under the header rows.)

export default function GridAndPanel({ grid, panel }) {
  return (
    <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {grid}
        <Legend />
      </div>
      <div className="w-full shrink-0 xl:sticky xl:top-0 xl:w-96 xl:max-h-screen xl:overflow-y-auto" data-testid="workbench-panel">
        {panel}
      </div>
    </div>
  );
}
