import { useState } from 'react';

// ─── A section of a context's page that starts folded to one line ────────
// The title and a short summary ("3 properties · also known as HA") on a button
// that opens it; `actions` sit on the right of that line and stay visible while
// folded. Open or closed is the page's when it passes `open` and `onOpenChange`
// (the attention line under the header opens a section and scrolls to it), else
// the section's own. `id` is where the page scrolls to.

export function Chevron({ open }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>
      <path fillRule="evenodd" d="M7.2 14.8a.75.75 0 0 1 0-1.06L10.94 10 7.2 6.26a.75.75 0 1 1 1.06-1.06l4.27 4.27a.75.75 0 0 1 0 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0Z" clipRule="evenodd" />
    </svg>
  );
}

export default function FoldSection({ id, title, summary, actions, open: controlled, onOpenChange, defaultOpen = false, testId, children }) {
  const [own, setOwn] = useState(defaultOpen);
  const open = controlled ?? own;
  const bodyId = id ? `${id}-body` : undefined;
  function toggle() {
    if (onOpenChange) onOpenChange(!open);
    else setOwn(!open);
  }
  return (
    <section id={id} aria-label={title} data-testid={testId}
      className="scroll-mt-4 rounded-lg border border-gray-200 bg-white px-6 py-3 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={bodyId}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
          <span className="self-center"><Chevron open={open} /></span>
          <h3 className="shrink-0 text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
          {summary && <span className="min-w-0 truncate text-xs text-gray-600 dark:text-gray-400" data-testid={testId ? `${testId}-summary` : undefined}>{summary}</span>}
        </button>
        {actions}
      </div>
      {open && <div id={bodyId} className="mt-3 space-y-3">{children}</div>}
    </section>
  );
}
