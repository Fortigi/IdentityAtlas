// The survey a #surveys hash points at: #surveys?request=<id>.

import { useEffect, useState } from 'react';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The request id in a hash like '#surveys?request=<uuid>', or null. Pure. */
export function requestFromHash(hash) {
  const raw = String(hash ?? '');
  const q = raw.indexOf('?');
  if (q < 0) return null;
  const id = new URLSearchParams(raw.slice(q + 1)).get('request');
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
}

/** The hash that opens one survey (or the list, without an id). */
export const surveyHash = (requestId) => (requestId ? `surveys?request=${requestId}` : 'surveys');

/** [requestId | null, open(requestId | null)] — kept in the hash so a survey has a link. */
export function useSurveyRoute() {
  const [requestId, setRequestId] = useState(() => requestFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setRequestId(requestFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const open = (id) => { window.location.hash = surveyHash(id); };
  return [requestId, open];
}
