import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { proposalPrincipals, lensPackages, withProposalCoverage } from './proposedLens';

// The data of the matrix's Proposed lens: the saved investigations to pick from,
// and — for the one picked, or all — the matrix rows of the accounts their proposed
// roles reach, with the proposals added as business-role bands and coverage.
//
// 1. GET  /api/workbench/investigations              the list (any unit)
// 2. GET  /api/workbench/investigations/:id          each picked one's proposed roles
// 3. GET  /api/contexts/:unit/workbench              each unit's people now (a rule is evaluated on them)
// 4. POST /api/workbench/proposals/matrix            the matrix rows of every account reached

async function json(authFetch, url, init) {
  const r = await authFetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
}

// The picked investigations' proposals, each with the accounts it reaches now.
async function resolveProposals(authFetch, invs) {
  const full = await Promise.all(invs.map(i => json(authFetch, `/api/workbench/investigations/${i.id}`)));
  const units = [...new Set(full.map(i => i.contextId))];
  const people = new Map(await Promise.all(units.map(async u => [u, (await json(authFetch, `/api/contexts/${u}/workbench?includeChildren=true`)).people])));
  return full.flatMap(inv => inv.proposals.map(p => ({
    ...p, investigationName: inv.name, principals: proposalPrincipals(p, people.get(inv.contextId) || []),
  })));
}

export async function loadProposedLens(authFetch, list, investigationId, realPackages) {
  const picked = investigationId ? list.filter(i => i.id === investigationId) : list;
  const proposals = await resolveProposals(authFetch, picked);
  const principalIds = [...new Set(proposals.flatMap(p => p.principals))];
  const rows = await json(authFetch, '/api/workbench/proposals/matrix', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ principalIds }),
  });
  return {
    proposals,
    data: rows.data,
    accessPackageGroups: [...(realPackages || []), ...lensPackages(proposals)],
    managedByPackages: withProposalCoverage(rows.managedByPackages, proposals),
  };
}

export function useProposedLens(investigationId, realPackages) {
  const { authFetch } = useAuth();
  const [list, setList] = useState(null);
  const [state, setState] = useState({ lens: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    json(authFetch, '/api/workbench/investigations')
      .then(b => { if (!cancelled) setList(b.data || []); })
      .catch(err => { if (!cancelled) { setList([]); setState({ lens: null, loading: false, error: err.message }); } });
    return () => { cancelled = true; };
  }, [authFetch]);

  useEffect(() => {
    if (list === null) return undefined;
    let cancelled = false;
    loadProposedLens(authFetch, list, investigationId, realPackages)
      .then(lens => { if (!cancelled) setState({ lens, loading: false, error: null }); })
      .catch(err => { if (!cancelled) setState({ lens: null, loading: false, error: err.message }); });
    return () => { cancelled = true; };
  }, [authFetch, list, investigationId, realPackages]);

  return { list, ...state };
}
