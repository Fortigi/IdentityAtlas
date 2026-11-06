import { useCallback, useEffect, useReducer, useState } from 'react';

// The paginated, searchable members of a context, for its detail page:
// GET /api/contexts/:id/members with limit/offset, ?search= and
// ?include=descendants. Re-reads when the page, the search, the scope or
// `refreshKey` changes; a new search or scope starts again at page 0.

export const MEMBER_PAGE_SIZE = 50;

export function useContextMembers(authFetch, contextId, refreshKey) {
  const [memberPage, setMemberPage] = useState(0);
  const [memberSearch, setMemberSearch] = useState('');
  const [includeDescendants, setIncludeDescendants] = useState(false);
  const [members, setMembers] = useState([]);
  const [memberTotal, setMemberTotal] = useState(0);
  // Flipped synchronously inside the fetch effect; a reducer dispatch keeps
  // that clear of set-state-in-effect.
  const [membersLoading, setMembersLoading] = useReducer((_, v) => v, false);
  // A failed read is shown ("Members could not be loaded"), never passed off as an empty unit.
  const [membersError, setMembersError] = useReducer((_, v) => v, null);

  const fetchMembers = useCallback(() => {
    setMembersLoading(true);
    setMembersError(null);
    const params = new URLSearchParams({
      limit: String(MEMBER_PAGE_SIZE),
      offset: String(memberPage * MEMBER_PAGE_SIZE),
    });
    if (memberSearch) params.set('search', memberSearch);
    if (includeDescendants) params.set('include', 'descendants');
    return authFetch(`/api/contexts/${contextId}/members?${params}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setMembers(data.data || []);
        setMemberTotal(data.total || 0);
      })
      .catch((err) => {
        console.error('Failed to load context members:', err);
        setMembersError(err.message || 'Failed to load members');
      })
      .finally(() => setMembersLoading(false));
  }, [authFetch, contextId, memberPage, memberSearch, includeDescendants]);

  useEffect(() => { fetchMembers(); }, [fetchMembers, refreshKey]);

  // Reset page when search / scope changes — during render via a composite
  // compare, so no synchronous setState lives in an effect.
  const memberFilterSig = `${memberSearch}|${includeDescendants}`;
  const [seenMemberFilterSig, setSeenMemberFilterSig] = useState(memberFilterSig);
  if (memberFilterSig !== seenMemberFilterSig) {
    setSeenMemberFilterSig(memberFilterSig);
    setMemberPage(0);
  }

  return {
    members, memberTotal, membersLoading, membersError, fetchMembers,
    memberPage, setMemberPage, memberSearch, setMemberSearch, includeDescendants, setIncludeDescendants,
  };
}
