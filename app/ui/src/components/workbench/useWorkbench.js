import { useCallback, useEffect, useReducer, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { EMPTY_CANDIDATE, toggleAll, addSelection, proposeEntitlements, candidateFromRole } from './workbench.model';

// The workbench's data (GET /api/contexts/:id/workbench, read again after a
// knowledge change) and the analyst's draft: selection, marks and the candidate
// role. The draft is keyed by person and resource, so re-reading the data or
// changing the grouping keeps it. Session only: nothing in the draft is saved.

async function readJson(authFetch, url, init) {
  const r = await authFetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
}

export function useWorkbenchData(contextId, includeChildren) {
  const { authFetch } = useAuth();
  const [state, setState] = useState({ data: null, loading: true, error: null });

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true }));
    try {
      const data = await readJson(authFetch, `/api/contexts/${contextId}/workbench?includeChildren=${includeChildren}`);
      setState({ data, loading: false, error: null });
    } catch (err) {
      setState(s => ({ ...s, loading: false, error: err.message }));
    }
  }, [authFetch, contextId, includeChildren]);

  useEffect(() => { load(); }, [load]);

  const send = useCallback((url, method, body) => readJson(authFetch, url, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), [authFetch]);

  return { ...state, reload: load, send };
}

const INITIAL_DRAFT = { selection: new Set(), anchor: null, marks: new Map(), candidate: EMPTY_CANDIDATE };

function setMarks(marks, keys, mark) {
  const next = new Map(marks);
  for (const k of keys) { if (mark) next.set(k, mark); else next.delete(k); }
  return next;
}

const without = (set, value) => { const next = new Set(set); next.delete(value); return next; };

// Each action changes one part of the draft; the grid and the panel dispatch them.
const ACTIONS = {
  select: (s, a) => ({ ...s, selection: a.add ? toggleAll(s.selection, a.keys) : new Set(a.keys), anchor: a.anchor ?? s.anchor }),
  clearSelection: (s) => ({ ...s, selection: new Set(), anchor: null }),
  mark: (s, a) => ({ ...s, marks: setMarks(s.marks, s.selection, a.mark) }),
  addSelection: (s, a) => ({ ...s, candidate: addSelection(s.candidate, s.selection, a.cellIndex) }),
  addMembers: (s, a) => ({ ...s, candidate: { ...s.candidate, members: new Set([...s.candidate.members, ...a.people]) } }),
  removeMember: (s, a) => ({ ...s, candidate: { ...s.candidate, members: without(s.candidate.members, a.person) } }),
  removeEntitlement: (s, a) => ({ ...s, candidate: { ...s.candidate, entitlements: without(s.candidate.entitlements, a.resourceId) } }),
  addEntitlement: (s, a) => ({ ...s, candidate: { ...s.candidate, entitlements: new Set([...s.candidate.entitlements, a.resourceId]) } }),
  propose: (s, a) => ({
    ...s, candidate: { ...s.candidate, entitlements: proposeEntitlements(s.candidate.members, a.columns, a.cellIndex, s.marks, a.threshold) },
  }),
  fromRole: (s, a) => ({ ...s, candidate: candidateFromRole(a.role, a.cellsByResource) }),
  newCandidate: (s) => ({ ...s, candidate: { ...EMPTY_CANDIDATE, members: new Set(), entitlements: new Set() } }),
  edit: (s, a) => ({ ...s, candidate: { ...s.candidate, [a.field]: a.value } }),
  reset: () => ({ ...INITIAL_DRAFT, selection: new Set(), marks: new Map() }),
};

export function draftReducer(state, action) {
  const fn = ACTIONS[action.type];
  return fn ? fn(state, action) : state;
}

export function useWorkbenchDraft() {
  return useReducer(draftReducer, INITIAL_DRAFT);
}
