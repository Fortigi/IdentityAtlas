import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';

// The chain of parents above a context, root first: [{ id, displayName }].
// GET /api/contexts/:id names only the direct parent, so each parent is read
// in turn for its own parent. A failed read ends the chain there (keeping the
// name we already have), as does a cycle or MAX_DEPTH levels. Until the walk
// finishes the known direct parent stands in, so the breadcrumb never flashes
// empty. With walk=false only that direct parent is named and nothing is read
// (a read-only shell whose reader may not open the parents).

const MAX_DEPTH = 8;

async function readParent(authFetch, id) {
  try {
    const r = await authFetch(`/api/contexts/${id}`);
    if (!r.ok) return null;
    return (await r.json())?.attributes || null;
  } catch {
    return null;
  }
}

export async function walkAncestors(authFetch, attrs) {
  const items = [];
  const seen = new Set([attrs.id]);
  let id = attrs.parentContextId;
  let name = attrs.parentDisplayName;
  while (id && !seen.has(id) && items.length < MAX_DEPTH) {
    seen.add(id);
    const parent = await readParent(authFetch, id);
    items.unshift({ id, displayName: parent?.displayName || name || id });
    if (!parent) break;
    id = parent.parentContextId;
    name = parent.parentDisplayName;
  }
  return items;
}

export function useContextAncestors(attrs, { walk = true } = {}) {
  const { authFetch } = useAuth();
  const [walked, setWalked] = useState({ key: null, items: [] });
  const key = `${attrs.id}|${attrs.parentContextId || ''}`;

  useEffect(() => {
    if (!attrs.parentContextId || !walk) return undefined;
    let cancelled = false;
    walkAncestors(authFetch, attrs).then(items => { if (!cancelled) setWalked({ key, items }); });
    return () => { cancelled = true; };
  }, [authFetch, key, attrs, walk]);

  if (!attrs.parentContextId) return [];
  if (walk && walked.key === key) return walked.items;
  return [{ id: attrs.parentContextId, displayName: attrs.parentDisplayName || attrs.parentContextId }];
}
