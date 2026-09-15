import { useCallback, useEffect, useRef, useState } from 'react';

// Open/close state for a small popover anchored to a trigger button: the
// matrix's Export menu and the grid's "How to read this matrix" legend.
//
//   - toggle() opens/closes it from the trigger;
//   - a mousedown outside BOTH the trigger and the panel closes it (the panel
//     may be portalled elsewhere in the DOM, so it is checked separately);
//   - Escape closes it and hands focus back to the trigger;
//   - on open, focus moves into the panel — to the element marked
//     `data-autofocus` when there is one, otherwise the panel itself.
export function usePopover() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const toggle = useCallback(() => setOpen(o => !o), []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;
    (panel?.querySelector('[data-autofocus]') || panel)?.focus();

    const inside = (target) =>
      !!(triggerRef.current?.contains(target) || panelRef.current?.contains(target));
    const onMouseDown = (e) => { if (!inside(e.target)) setOpen(false); };
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return { open, toggle, close, triggerRef, panelRef };
}
