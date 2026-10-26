import { useEffect, useRef } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useContextClaims } from '@ui/components/contexts/interviews/claimsContext';
import { splitRequests } from './changeRequests.helpers';

// A context's change requests (GET /api/change-requests?contextId=…), split into
// open and closed, for the page's Change requests section and the attention
// line's "n to correct in the source". Read again whenever the context's claims
// change after the first read, so a decision shows up straight away. Analysts
// only (`enabled`): the page shows a reader no correction work.

export function useChangeRequests(contextId, { enabled = true } = {}) {
  const { authFetch } = useAuth();
  const claims = useContextClaims()?.claims;
  const { data, reload } = useFetch(`/api/change-requests?contextId=${encodeURIComponent(contextId)}`, {
    authFetch, enabled: enabled && !!contextId, initialData: null,
  });
  // The first fetch is useFetch's own; read again only when the claims change after it.
  const seenClaims = useRef(claims);
  useEffect(() => {
    if (seenClaims.current === claims) return;
    seenClaims.current = claims;
    reload();
  }, [claims, reload]);
  return splitRequests(data?.items);
}
