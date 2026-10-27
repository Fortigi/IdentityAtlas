import { useCallback, useEffect, useReducer, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { EMPTY_CANDIDATE, toggleAll, addSelection, proposeEntitlements, candidateFromRole } from './workbench.model';

// The workbench's data (GET /api/contexts/:id/workbench, read again after a
// knowledge change) and the analyst's draft: selection, marks and the candidate
// role. The draft is keyed by person and resource, so re-reading the data or
// changing the grouping keeps it. It lives in the tab until the analyst saves it as
// an investigation (useInvestigation.js).

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

// The session's draft: the selection, the analyst's marks, and the proposed roles.
// `drafts` is a plain list — { id, name, description, baseBusinessRoleId, members,
// entitlements } (members: person keys, entitlements: resource ids, both Sets) —
// one per proposed role; `activeId` is the one the panel edits and the impact
// reads; `viewRoleId` an existing business role the panel shows read-only.
const INITIAL_DRAFT = { selection: new Set(), anchor: null, marks: new Map(), drafts: [], activeId: null, viewRoleId: null, nextId: 1 };

function setMarks(marks, keys, mark) {
  const next = new Map(marks);
  for (const k of keys) { if (mark) next.set(k, mark); else next.delete(k); }
  return next;
}

const without = (set, value) => { const next = new Set(set); next.delete(value); return next; };

/** The proposed role the panel edits, or an empty one (id null) when there is none. Pure. */
export function activeDraft(state) {
  return state.drafts.find(d => d.id === state.activeId) ?? EMPTY_CANDIDATE;
}

// A new proposed role, made the active one.
function createDraft(s, init = {}) {
  const id = `draft:${s.nextId}`;
  const d = { id, name: `Candidate ${s.nextId}`, description: '', baseBusinessRoleId: null, members: new Set(), entitlements: new Set(), ...init };
  return { ...s, drafts: [...s.drafts, { ...d, id }], activeId: id, viewRoleId: null, nextId: s.nextId + 1 };
}

// Change the active proposed role (one is made when there is none yet).
function withActive(s, fn) {
  const st = s.drafts.some(d => d.id === s.activeId) ? s : createDraft(s);
  return { ...st, viewRoleId: null, drafts: st.drafts.map(d => (d.id === st.activeId ? fn(d) : d)) };
}

// A saved investigation's marks and proposed roles (save and reopen, M2a). After a
// save (`keep`) the proposed roles come back with their saved ids in the same
// order, so the open one stays open and the selection stays; on opening one, the
// first proposed role is opened and the selection cleared.
function loadSaved(s, a) {
  const index = s.drafts.findIndex(d => d.id === s.activeId);
  const activeId = a.keep ? (a.drafts[index]?.id ?? null) : (a.drafts[0]?.id ?? null);
  const base = { ...s, marks: a.marks, drafts: a.drafts, activeId, viewRoleId: null };
  return a.keep ? base : { ...base, selection: new Set(), anchor: null, nextId: a.drafts.length + 1 };
}

function removeDraft(s, id) {
  const drafts = s.drafts.filter(d => d.id !== id);
  const activeId = s.activeId === id ? (drafts.at(-1)?.id ?? null) : s.activeId;
  return { ...s, drafts, activeId };
}

// Each action changes one part of the draft; the grid and the panel dispatch them.
const ACTIONS = {
  select: (s, a) => ({ ...s, selection: a.add ? toggleAll(s.selection, a.keys) : new Set(a.keys), anchor: a.anchor ?? s.anchor }),
  clearSelection: (s) => ({ ...s, selection: new Set(), anchor: null }),
  mark: (s, a) => ({ ...s, marks: setMarks(s.marks, s.selection, a.mark) }),
  // Added cells leave the selection, so the impact shows without outlines over it.
  addSelection: (s, a) => ({ ...withActive(s, d => addSelection(d, s.selection, a.cellIndex)), selection: new Set(), anchor: null }),
  addMembers: (s, a) => withActive(s, d => ({ ...d, members: new Set([...d.members, ...a.people]) })),
  removeMember: (s, a) => withActive(s, d => ({ ...d, members: without(d.members, a.person) })),
  removeEntitlement: (s, a) => withActive(s, d => ({ ...d, entitlements: without(d.entitlements, a.resourceId) })),
  propose: (s, a) => withActive(s, d => ({ ...d, entitlements: proposeEntitlements(d.members, a.columns, a.cellIndex, s.marks, a.threshold) })),
  fromRole: (s, a) => createDraft(s, candidateFromRole(a.role, a.cellsByResource)),
  newCandidate: (s) => createDraft(s),
  edit: (s, a) => withActive(s, d => ({ ...d, [a.field]: a.value })),
  selectDraft: (s, a) => ({ ...s, activeId: a.id, viewRoleId: null }),
  viewRole: (s, a) => ({ ...s, viewRoleId: a.id }),
  closeRole: (s) => ({ ...s, viewRoleId: null }),
  removeDraft: (s, a) => removeDraft(s, a.id),
  loadSaved,
  reset: () => ({ ...INITIAL_DRAFT, selection: new Set(), marks: new Map() }),
};

export function draftReducer(state, action) {
  const fn = ACTIONS[action.type];
  return fn ? fn(state, action) : state;
}

export function useWorkbenchDraft() {
  return useReducer(draftReducer, INITIAL_DRAFT);
}