// The current hash page-key, kept in sync with the browser's hash.
//
// Extracted from App.jsx so the root dispatcher (AppRoot) and the app shell
// read the route the same way instead of each keeping its own listener.
// Returns [page, navigate] — `page` is the decoded hash with any query string
// stripped ('dashboard' when the hash is empty).

import { useState, useEffect, useCallback } from 'react';

export function currentHashPage() {
  const raw = decodeURIComponent(window.location.hash.replace('#', '') || 'dashboard');
  const qIndex = raw.indexOf('?');
  return qIndex >= 0 ? raw.substring(0, qIndex) : raw;
}

export function useHashPage() {
  const [page, setPage] = useState(currentHashPage);
  useEffect(() => {
    const onHash = () => setPage(currentHashPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((p) => { window.location.hash = p; }, []);
  return [page, navigate];
}
