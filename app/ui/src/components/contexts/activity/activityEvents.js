import { useEffect, useState } from 'react';

// "The activity of this context changed" — said by the upload wizard after an
// import, heard by the Activity section next to it on the page. The card and
// the section are siblings in different parts of the profile (the Actions area
// and the section below it), so a window event keeps both self-contained.

export const ACTIVITY_CHANGED = 'ia:context-activity-changed';

export function notifyActivityChanged(contextId) {
  window.dispatchEvent(new CustomEvent(ACTIVITY_CHANGED, { detail: { contextId } }));
}

/** A number that goes up each time this context's activity changed. */
export function useActivityVersion(contextId) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onChange = (e) => { if (e.detail?.contextId === contextId) setVersion(v => v + 1); };
    window.addEventListener(ACTIVITY_CHANGED, onChange);
    return () => window.removeEventListener(ACTIVITY_CHANGED, onChange);
  }, [contextId]);
  return version;
}
