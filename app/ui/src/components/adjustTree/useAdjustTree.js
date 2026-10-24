import { useCallback, useEffect, useReducer } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { addedUnitId, withReason } from './adjustTree.helpers';

// The data of one Adjust tree screen: the tree, its adjustments and what needs
// attention — read together, and read again after every change so the counts,
// marks and statuses the API computes stay right. The writes are the
// adjustment routes of the API contract; each resolves to the adjustment the
// API returned, or throws the API's message.

export function treeUrl(treeKey, suffix = '') {
  return `/api/context-trees/${encodeURIComponent(treeKey)}${suffix}`;
}

async function readJson(authFetch, url) {
  const r = await authFetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error || (r.status === 404 ? 'This tree was not found.' : `HTTP ${r.status}`));
  }
  return r.json();
}

async function send(authFetch, url, method, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const r = await authFetch(url, init);
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(payload?.error || `HTTP ${r.status}`);
  return payload?.adjustment || payload;
}

const INITIAL = { tree: null, adjustments: [], attention: [], loading: true, error: null, version: 0 };

// 'loaded' takes the three reads (and bumps `version`, which tells member lists
// to read again); 'failed' keeps what was shown and adds the error.
function reducer(state, action) {
  if (action.type === 'loaded') return { ...state, ...action.data, loading: false, error: null, version: state.version + 1 };
  return { ...state, loading: false, error: action.error };
}

export function useAdjustTree(treeKey) {
  const { authFetch } = useAuth();
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const load = useCallback(async () => {
    try {
      const [tree, adj, att] = await Promise.all([
        readJson(authFetch, treeUrl(treeKey)),
        readJson(authFetch, treeUrl(treeKey, '/adjustments')),
        readJson(authFetch, treeUrl(treeKey, '/attention')),
      ]);
      dispatch({ type: 'loaded', data: { tree, adjustments: adj.data || [], attention: att.data || [] } });
    } catch (err) {
      dispatch({ type: 'failed', error: err.message || 'Failed to load the tree' });
    }
  }, [authFetch, treeKey]);

  useEffect(() => { load(); }, [load]);

  // Each write, then the re-read; resolves to the adjustment.
  const after = useCallback(async (write) => {
    const adjustment = await write();
    await load();
    return adjustment;
  }, [load]);

  const post = useCallback((body) => after(() => send(authFetch, treeUrl(treeKey, '/adjustments'), 'POST', body)), [after, authFetch, treeKey]);
  const undo = useCallback((id) => after(() => send(authFetch, treeUrl(treeKey, `/adjustments/${encodeURIComponent(id)}`), 'DELETE')), [after, authFetch, treeKey]);
  const redo = useCallback((id) => after(() => send(authFetch, treeUrl(treeKey, `/adjustments/${encodeURIComponent(id)}/redo`), 'POST')), [after, authFetch, treeKey]);
  const follow = useCallback((id) => after(() => send(authFetch, treeUrl(treeKey, `/adjustments/${encodeURIComponent(id)}/follow`), 'POST')), [after, authFetch, treeKey]);

  // Put units under a new unit (Group into new unit…, Add a level above): add
  // the unit, find its id, move each unit under it — one after the other, as
  // each move is its own adjustment — then re-read once. Resolves to every
  // adjustment made, the new unit's first, so Undo can take them all back.
  const groupUnits = useCallback(async ({ name, parentId, unitIds, reason }) => {
    const done = [];
    try {
      const added = await send(authFetch, treeUrl(treeKey, '/adjustments'), 'POST', withReason({ op: 'addUnit', parentId, name }, reason));
      done.push(added);
      const tree = await readJson(authFetch, treeUrl(treeKey));
      const newId = addedUnitId(added, tree.units, { name, parentId });
      if (!newId) throw new Error(`The new unit "${name}" was added, but could not be found to move the units under it.`);
      for (const subjectId of unitIds) {
        done.push(await send(authFetch, treeUrl(treeKey, '/adjustments'), 'POST', withReason({ op: 'moveUnit', subjectId, toParentId: newId }, reason)));
      }
    } finally {
      await load();
    }
    return done;
  }, [authFetch, load, treeKey]);

  return { ...state, reload: load, post, groupUnits, undo, redo, follow };
}
