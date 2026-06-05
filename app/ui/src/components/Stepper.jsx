// Shared multi-step wizard indicator — one component for every wizard so the
// step UI is consistent everywhere. The active step is blue (the interactive
// role in the UI Style Guide), completed steps show a ✓, and steps are joined
// by chevron separators. Dark-mode aware.
//
// Props:
//   steps        [{ n, label, shown? }] — n is the step number; shown:false hides it
//   current      number                  — the active step's n
//   onStepClick  (n) => void  (optional) — when provided, steps become clickable
//   allowAll     boolean                  — also allow jumping to future steps (edit mode)
export default function Stepper({ steps, current, onStepClick, allowAll = false }) {
  const visible = steps.filter(s => s.shown !== false);
  const isClickable = (n) => {
    if (!onStepClick) return false;
    if (allowAll) return true;
    return n <= current;
  };
  return (
    <div className="flex items-center gap-2 text-xs">
      {visible.map((s, i, arr) => {
        const clickable = isClickable(s.n);
        const active = s.n === current;
        const done = s.n < current;
        const bubbleCls = active
          ? 'bg-blue-600 text-white'
          : done
            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
            : 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400';
        const labelCls = active
          ? 'font-medium text-gray-900 dark:text-white'
          : done
            ? 'text-gray-700 dark:text-gray-300'
            : 'text-gray-500 dark:text-gray-400';
        const content = (
          <>
            <span className={`w-6 h-6 rounded-full flex items-center justify-center font-semibold ${bubbleCls} ${clickable ? 'group-hover:ring-2 group-hover:ring-blue-300 transition' : ''}`}>
              {done ? '✓' : i + 1}
            </span>
            <span className={`${labelCls} ${clickable ? 'group-hover:text-blue-700 dark:group-hover:text-blue-300 group-hover:underline' : ''}`}>{s.label}</span>
          </>
        );
        return (
          <div key={s.n} className="flex items-center gap-2">
            {clickable ? (
              <button
                type="button"
                onClick={() => onStepClick(s.n)}
                className="group flex items-center gap-2 cursor-pointer focus:outline-none"
                aria-label={`Go to step ${i + 1}: ${s.label}`}
              >{content}</button>
            ) : (
              <div className="flex items-center gap-2">{content}</div>
            )}
            {i < arr.length - 1 && <span className="text-gray-500 dark:text-gray-600" aria-hidden="true">›</span>}
          </div>
        );
      })}
    </div>
  );
}
