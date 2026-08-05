import { RESIZE_STEP } from '@ui/hooks/useResizableGridHeight';

// The grip under the matrix grid: drag it to give the grid more (or less) of
// the window than the measured fit gives it, double-click — or use "Fit to
// window" — to hand the decision back.
//
// Arrow keys resize it too: a mouse-only resize would put the height out of
// reach of a keyboard user, and the grip is the only control for it.
export default function GridResizeHandle({ isCustom, onStartDrag, onResizeBy, onReset }) {
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); onResizeBy(RESIZE_STEP); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); onResizeBy(-RESIZE_STEP); }
    else if (e.key === 'Home' || e.key === 'Escape') { e.preventDefault(); onReset(); }
  };

  // Fixed height on purpose: the "Fit to window" link comes and goes, and a row
  // that changed size with it would move the grid's measured fit by a few px
  // every time — which the measuring hook has no reason to re-run for.
  return (
    <div className="flex h-6 items-center justify-center gap-3 -mt-1">
      <button
        type="button"
        aria-label="Resize the matrix height"
        title="Drag to resize the matrix (or use the arrow keys); double-click to fit it to the window"
        onPointerDown={(e) => { e.preventDefault(); onStartDrag(e.clientY); }}
        onDoubleClick={onReset}
        onKeyDown={onKeyDown}
        className="cursor-ns-resize touch-none px-6 py-1 rounded group focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <span
          className="block h-1 w-10 rounded-full bg-gray-300 group-hover:bg-gray-400 dark:bg-gray-600 dark:group-hover:bg-gray-500"
          aria-hidden="true"
        />
      </button>
      {isCustom && (
        <button
          type="button"
          onClick={onReset}
          className="text-[11px] text-gray-600 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 underline decoration-dotted"
        >
          Fit to window
        </button>
      )}
    </div>
  );
}
