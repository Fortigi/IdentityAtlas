import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { buildVariants, linksNeedingCount, memberCount, sameUnitLinks } from './variants.helpers';

// This context and its variants (SameUnitAs), each with its member count.
// The relationship rows name the related context but not its size, so each
// related context's detail is read once for its count. A failed read leaves
// that count unknown rather than hiding the variant.
export function useUnitVariants(attrs) {
  const { authFetch } = useAuth();
  const { data: links, loading } = useFetch(`/api/contexts/${attrs.id}/relationships`, {
    authFetch, initialData: [], transform: sameUnitLinks,
  });
  const [counts, setCounts] = useState(() => new Map());

  useEffect(() => {
    const missing = linksNeedingCount(links, counts);
    if (missing.length === 0) return undefined;
    let cancelled = false;
    Promise.all(missing.map(l =>
      authFetch(`/api/contexts/${l.relatedContextId}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
    )).then(results => {
      if (cancelled) return;
      setCounts(prev => {
        const next = new Map(prev);
        missing.forEach((l, i) => next.set(l.relatedContextId, memberCount(results[i]?.attributes)));
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [links, counts, authFetch]);

  const variants = useMemo(() => buildVariants(attrs, links, counts), [attrs, links, counts]);
  return { variants, loading };
}
