import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { proposalRows } from './unitProposals';

async function json(authFetch, url) {
  const r = await authFetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
}

/**
 * The unit's saved workbench investigations (GET /api/contexts/:id/workbench/investigations:
 * each with its proposed roles' ids and names) — for the count on the workbench
 * button and the "Proposed roles" line. Only when `enabled` (an analyst on an
 * organizational unit: the endpoint is the workbench's). null until read; [] when
 * reading fails (the page goes on without it).
 */
export function useUnitInvestigations(contextId, enabled) {
  const { authFetch } = useAuth();
  const [list, setList] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    json(authFetch, `/api/contexts/${contextId}/workbench/investigations`)
      .then(b => { if (!cancelled) setList(b.data ?? []); })
      .catch(() => { if (!cancelled) setList([]); });
    return () => { cancelled = true; };
  }, [authFetch, contextId, enabled]);
  return enabled ? list : null;
}

/**
 * The rows of the "Proposed roles" section, read when it is opened: each
 * investigation that holds a proposed role in full, and the unit's workbench data
 * (its people now, so a rule says who it reaches, and its existing roles, for the colours).
 */
export function useProposalRows(contextId, list, open) {
  const { authFetch } = useAuth();
  const [state, setState] = useState({ rows: null, error: null });
  useEffect(() => {
    const invs = (list || []).filter(i => i.proposals?.length > 0);
    if (!open || invs.length === 0) return undefined;
    let cancelled = false;
    Promise.all([
      Promise.all(invs.map(i => json(authFetch, `/api/workbench/investigations/${i.id}`))),
      json(authFetch, `/api/contexts/${contextId}/workbench?includeChildren=true`),
    ])
      .then(([full, data]) => { if (!cancelled) setState({ rows: proposalRows(full, data), error: null }); })
      .catch(err => { if (!cancelled) setState({ rows: null, error: err.message }); });
    return () => { cancelled = true; };
  }, [authFetch, contextId, list, open]);
  return state;
}
