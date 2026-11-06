import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { proposalPrincipals } from './proposedLens';

// The data of the matrix's "+ Proposed roles" toggle: the saved investigations
// to pick from, and — for the one picked, or all — their proposed roles, each
// with the accounts it reaches now. The matrix adds those on top of the view it
// already shows (ProposedMatrix); it reads no rows of its own.
//
// 1. GET  /api/workbench/investigations              the list (any unit)
// 2. GET  /api/workbench/investigations/:id          each picked one's proposed roles
// 3. GET  /api/contexts/:unit/workbench              each unit's people now (a rule is evaluated on them)

async function json(authFetch, url) {
  const r = await authFetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
}

/** The picked investigations' proposals, each with the accounts it reaches now; [] when none is picked. */
export async function loadProposals(authFetch, list, investigationId) {
  const picked = investigationId ? list.filter(i => i.id === investigationId) : list;
  if (picked.length === 0) return [];
  const full = await Promise.all(picked.map(i => json(authFetch, `/api/workbench/investigations/${i.id}`)));
  const units = [...new Set(full.map(i => i.contextId))];
  const people = new Map(await Promise.all(units.map(async u => [u, (await json(authFetch, `/api/contexts/${u}/workbench?includeChildren=true`)).people])));
  return full.flatMap(inv => inv.proposals.map(p => ({
    ...p, investigationName: inv.name, principals: proposalPrincipals(p, people.get(inv.contextId) || []),
  })));
}

export function useProposedLens(investigationId) {
  const { authFetch } = useAuth();
  const [list, setList] = useState(null);
  const [state, setState] = useState({ proposals: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    json(authFetch, '/api/workbench/investigations')
      .then(b => { if (!cancelled) setList(b.data || []); })
      .catch(err => { if (!cancelled) setState({ proposals: null, loading: false, error: err.message }); });
    return () => { cancelled = true; };
  }, [authFetch]);

  useEffect(() => {
    if (list === null) return undefined;
    let cancelled = false;
    loadProposals(authFetch, list, investigationId)
      .then(proposals => { if (!cancelled) setState({ proposals, loading: false, error: null }); })
      .catch(err => { if (!cancelled) setState({ proposals: null, loading: false, error: err.message }); });
    return () => { cancelled = true; };
  }, [authFetch, list, investigationId]);

  return { list, ...state };
}
