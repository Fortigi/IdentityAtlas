import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthGate';

// ─── Member typeahead for manual contexts ─────────────────────────────────────
// Renders an input + debounced search; clicking a result POSTs to
// /api/contexts/:id/members. The list of already-attached members + the
// "Remove" button per row live in the members table in ContextDetailPage —
// this component is strictly the "add" side.
//
// Search endpoint is chosen per targetType. All three of identities /
// resources / users already support ?search; systems don't, but the list is
// short so we just fetch all and filter client-side.

const SEARCH_ENDPOINT = {
  Identity:  '/api/identities',
  Resource:  '/api/resources',
  Principal: '/api/users',
  System:    '/api/systems',
};

export default function ContextMemberPicker({ contextId, targetType, onAdded, existingMemberIds }) {
  const { authFetch } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(null);   // memberId currently being added
  const dropdownRef = useRef(null);
  const [open, setOpen] = useState(false);

  const existing = useMemo(() => new Set(existingMemberIds || []), [existingMemberIds]);

  // Debounced search.
  useEffect(() => {
    const endpoint = SEARCH_ENDPOINT[targetType];
    if (!endpoint) { setResults([]); return; }

    const handle = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        const url = targetType === 'System'
          ? endpoint
          : `${endpoint}?search=${encodeURIComponent(query.trim())}&limit=10`;
        const r = await authFetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json();
        let rows = body.data || body || [];
        if (targetType === 'System' && query.trim()) {
          const q = query.trim().toLowerCase();
          rows = rows.filter(s => (s.displayName || '').toLowerCase().includes(q));
        }
        setResults(rows.slice(0, 10));
      } catch (err) {
        setError(err.message || 'Search failed');
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [authFetch, query, targetType]);

  // Close dropdown on outside click.
  useEffect(() => {
    const onClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const add = useCallback(async (member) => {
    setAdding(member.id); setError(null);
    try {
      const r = await authFetch(`/api/contexts/${contextId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: member.id }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      onAdded?.(member);
      setQuery('');
      setResults([]);
      setOpen(false);
    } catch (err) {
      setError(err.message || 'Add failed');
    } finally {
      setAdding(null);
    }
  }, [authFetch, contextId, onAdded]);

  if (!SEARCH_ENDPOINT[targetType]) {
    return <p className="text-[11px] text-gray-500 dark:text-gray-400 dark:text-gray-500">No search endpoint for target type "{targetType}".</p>;
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <input
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={`Search ${targetType.toLowerCase()}s to add…`}
        className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400 dark:focus:ring-sky-500 focus:border-transparent"
      />

      {open && (results.length > 0 || loading) && (
        <div className="absolute left-0 right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg z-20 max-h-64 overflow-auto">
          {loading && <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500">Searching…</div>}
          {!loading && results.map(r => {
            const alreadyIn = existing.has(r.id);
            return (
              <button
                key={r.id}
                disabled={alreadyIn || adding === r.id}
                onClick={() => add(r)}
                className={`w-full text-left px-3 py-1.5 text-sm flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:bg-gray-700/50 ${alreadyIn ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span className="truncate">{r.displayName || r.id}</span>
                <span className="text-[11px] text-gray-400 dark:text-gray-500 ml-2">
                  {alreadyIn ? 'already a member' : adding === r.id ? 'adding…' : 'add'}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {error && <div className="mt-2 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded px-2 py-1">{error}</div>}
    </div>
  );
}
