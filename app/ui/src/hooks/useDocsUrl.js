import { useEffect, useState } from 'react';
import { docsUrl } from '../utils/docsUrl';

// Returns a `(path) => url` builder that points at the docs version matching
// the running build (edge vs stable). Fetches /api/version once (public, like
// useFeatures) so components without the version handy can still build a
// channel-correct docs link. See utils/docsUrl.
export default function useDocsUrl() {
  const [version, setVersion] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/version')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setVersion(d?.version || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return (path = '') => docsUrl(version, path);
}
