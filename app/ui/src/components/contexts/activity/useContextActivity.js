import { useEffect } from 'react';
import { useFetch } from '@ui/hooks/useFetch';
import { periodQuery } from './activity.helpers';

// The three reads behind a context's Activity section, refetched when the
// period changes or `version` goes up (an import or an undo):
//   own      GET /api/contexts/:id/activity            the four groups
//   summary  GET /api/contexts/:id/activity/summary    per sub-unit × month (only with sub-units)
//   uploads  GET /api/contexts/:id/activity/uploads    the history

export function useContextActivity(authFetch, contextId, { hasChildren, period, version }) {
  const base = `/api/contexts/${encodeURIComponent(contextId)}/activity`;
  const query = periodQuery(period);
  const own = useFetch(`${base}${query}`, { authFetch });
  const summary = useFetch(`${base}/summary${query}`, { authFetch, enabled: hasChildren });
  const uploads = useFetch(`${base}/uploads`, { authFetch, transform: (b) => b.data || [], initialData: [] });

  const { reload: reloadOwn } = own;
  const { reload: reloadSummary } = summary;
  const { reload: reloadUploads } = uploads;
  useEffect(() => {
    if (version === 0) return;
    reloadOwn(); reloadSummary(); reloadUploads();
  }, [version, reloadOwn, reloadSummary, reloadUploads]);

  return {
    own: own.data,
    summary: hasChildren ? summary.data : null,
    uploads: uploads.data || [],
    loading: own.loading || (hasChildren && summary.loading),
    error: own.error,
  };
}
