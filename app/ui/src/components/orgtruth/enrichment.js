// Enrichment attributes on a user / identity / resource page: what an
// enrichment list (e.g. expertises) says about this object, shown as ordinary
// attribute rows with the list as a small source chip.
//
//   GET /api/org-truth/enrichment/:targetType/:id
//     → { groups: [{ source: 'Maten', profileName, attributes: { expertises: ['IAM','Azure'], level: 'Senior' } }] }
//
// useOrgEnrichment fetches it only with the orgTruth feature on; a missing
// route (404/501) or any failure is simply no rows. Kept apart from the .jsx so
// it is mutated (stryker.orgtruth.config.json).
import { useMemo } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useFeatureFlags } from '@ui/contexts/FeaturesContext';

const display = (v) => (Array.isArray(v) ? v.filter(x => x != null && x !== '').join(', ') : v);

// AttributesTable entries: [key, value, { label, source }]. The key is
// namespaced (`org.<source>.<attribute>`, the same field the matrix filters
// on) so two lists with an attribute of one name never collide.
export function enrichmentEntries(data) {
  return (data?.groups ?? []).flatMap(g => Object.entries(g.attributes ?? {})
    .map(([name, v]) => [`org.${g.source}.${name}`, display(v), { label: name, source: g.source }])
    .filter(([, v]) => v != null && v !== ''));
}

export function enrichmentUrl(targetType, id) {
  return `/api/org-truth/enrichment/${encodeURIComponent(targetType)}/${encodeURIComponent(id)}`;
}

export function useOrgEnrichment(targetType, id) {
  const { authFetch } = useAuth();
  const enabled = useFeatureFlags().orgTruth === true && Boolean(id);
  const { data, error } = useFetch(enabled ? enrichmentUrl(targetType, id) : null, { authFetch, enabled });
  return useMemo(() => (enabled && !error ? enrichmentEntries(data) : []), [enabled, error, data]);
}
