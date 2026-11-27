// The reviews a campaign asks of the signed-in person (/api/review-requests/mine),
// loaded once by the page that shows the notice (the owner's page) and shared
// with the parts that mark a role as waiting or need the notice refreshed after
// a review is signed.
//
// Default: nothing is asked and reloading does nothing, so a component can use
// the hooks anywhere.

import { createContext, useContext, useMemo } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useFeatureFlags } from '@ui/contexts/FeaturesContext';

const NOTHING = Object.freeze({ requests: [], reload: () => {} });

export const ReviewRequestsContext = createContext(NOTHING);

/** { requests, reload }: what the signed-in person is asked to review. */
export function useReviewRequests() {
  return useContext(ReviewRequestsContext);
}

/**
 * Loads the requests for a provider. Asks nothing while Composition review is
 * off (`enabled` overrides the flag for a page that provides the flags itself).
 */
export function useLoadReviewRequests(enabled) {
  const { authFetch } = useAuth();
  const flag = useFeatureFlags().compositionReview === true;
  const on = enabled ?? flag;
  const { data, reload } = useFetch('/api/review-requests/mine', { authFetch, enabled: on });
  return useMemo(() => ({ requests: on && Array.isArray(data?.requests) ? data.requests : [], reload }), [on, data, reload]);
}
