import { useId, useRef, useState } from 'react';

// ─── A small icon that says "a source says something here" ───────────────
// Hover or focus shows a compact popover with what was said (the children);
// Escape closes it and leaves the focus on the icon; leaving the icon and its
// popover closes it. A click runs `onActivate` (the analyst's "open the source at
// the quote") and otherwise pins the popover open. The popover is always in the
// DOM (hidden while closed) so the icon's aria-describedby has something to read.
//
// variant  'proposed'  outlined, dashed — nobody decided it yet
//          'confirmed' solid
//          'warning'   amber — two statements disagree, a decision is waiting
// glyph    'role' | 'membership' | 'history' | 'warning'

const PATHS = {
  // a person with a badge
  role: 'M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.25a7.5 7.5 0 0 1 15 0',
  // two people
  membership: 'M15 19.13a9.38 9.38 0 0 0 2.63.37 9.34 9.34 0 0 0 4.12-.95 4.13 4.13 0 0 0-7.53-2.49M15 19.13v-.01c0-1.1-.29-2.14-.78-3.04M15 19.13a12.32 12.32 0 0 1-6.38 1.62c-2.33 0-4.51-.64-6.37-1.76a6.38 6.38 0 0 1 11.97-2.94M12 6.38a3.38 3.38 0 1 1-6.75 0 3.38 3.38 0 0 1 6.75 0Zm8.25 2.25a2.63 2.63 0 1 1-5.25 0 2.63 2.63 0 0 1 5.25 0Z',
  // a clock
  history: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  // a warning triangle
  warning: 'M12 9v3.75m-9.3 3.38c-.87 1.5.21 3.37 1.95 3.37h14.7c1.73 0 2.82-1.87 1.95-3.37L13.95 3.38c-.87-1.5-3.03-1.5-3.9 0L2.7 16.13ZM12 15.75h.01',
};

const VARIANT_CLASS = {
  proposed: 'border border-dashed border-gray-500 text-gray-700 dark:border-gray-400 dark:text-gray-200',
  confirmed: 'border border-gray-700 bg-gray-700 text-white dark:border-gray-200 dark:bg-gray-200 dark:text-gray-900',
  warning: 'border border-amber-600 bg-amber-100 text-amber-900 dark:border-amber-400 dark:bg-amber-900/50 dark:text-amber-100',
};

export function Glyph({ name, className = 'h-3.5 w-3.5' }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={PATHS[name] || PATHS.role} />
    </svg>
  );
}

export default function ClaimIcon({ label, glyph, variant = 'confirmed', onActivate, testId, children }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const popoverId = useId();
  const buttonRef = useRef(null);
  const wrapRef = useRef(null);
  const shown = open || pinned;

  function close() { setOpen(false); setPinned(false); }
  function onKeyDown(e) {
    if (e.key !== 'Escape' || !shown) return;
    e.stopPropagation();
    close();
    buttonRef.current?.focus();
  }
  // Focus leaving the icon and its popover closes it; moving into the popover's buttons does not.
  function onBlur(e) {
    if (!wrapRef.current?.contains(e.relatedTarget)) close();
  }
  function onClick() {
    if (onActivate) onActivate();
    else setPinned(p => !p);
  }

  return (
    <span ref={wrapRef} className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!pinned) setOpen(false); }}
      onKeyDown={onKeyDown} onBlur={onBlur}>
      <button ref={buttonRef} type="button" aria-label={label} aria-describedby={popoverId} aria-expanded={shown}
        data-testid={testId} data-variant={variant} onFocus={() => setOpen(true)} onClick={onClick}
        className={`inline-flex h-6 w-6 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:focus-visible:ring-blue-400 ${VARIANT_CLASS[variant]}`}>
        <Glyph name={glyph} />
      </button>
      <div id={popoverId} role="group" aria-label={label} hidden={!shown}
        className="absolute left-0 sm:left-auto sm:right-0 top-full z-30 mt-1 w-80 max-w-[calc(100vw-2rem)] space-y-2 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-lg dark:border-gray-600 dark:bg-gray-800">
        {children}
      </div>
    </span>
  );
}
