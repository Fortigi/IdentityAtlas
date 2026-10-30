import { useState } from 'react';

// The edits the Contexts page's tree makes in place — sync a generated tree,
// re-parent, move a member, rename, add a child, delete a tree — plus the lazy
// member read. Every edit refreshes through `refresh()` (the forest, the roots
// and the detail beside it) so member counts stay right after each change.
// `nodes` is the forest, to inherit targetType / contextType for a new child.

// Send a JSON write; throw the API's error message (or the status) when it fails.
async function sendJson(authFetch, url, method, body) {
  const r = await authFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const p = await r.json().catch(() => ({})); throw new Error(p.error || `HTTP ${r.status}`); }
  return r;
}

// Find a node by id in the nested forest.
export function findNodeById(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNodeById(n.children, id);
    if (hit) return hit;
  }
  return null;
}

// Wait for a queued plugin run to finish (or two minutes to pass); its status.
async function waitForRun(authFetch, runId) {
  const deadline = Date.now() + 120000;
  let status = 'queued';
  while (runId && Date.now() < deadline) {
    await new Promise(res => setTimeout(res, 2000));
    const pr = await authFetch(`/api/context-plugins/runs/${runId}`);
    if (pr.ok) { status = (await pr.json()).status; if (status === 'succeeded' || status === 'failed') break; }
  }
  return status;
}

export function useContextTreeEdits({ authFetch, nodes, refresh, onTreeDeleted }) {
  const [editError, setEditError] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  // Run one edit: clear the old error, refresh on success, show the failure.
  async function edit(fallback, run) {
    setEditError(null);
    try {
      await run();
      await refresh();
    } catch (e) { setEditError(e.message || fallback); }
  }

  // Sync = re-run the generating plugin onto this tree so out-of-date
  // references update (e.g. a user who changed manager moves to the new node),
  // keeping all analyst edits. We poll the queued run, then refresh the view.
  async function syncTree(rootId) {
    setSyncing(true); setSyncMsg(null);
    await edit('Refresh failed', async () => {
      const r = await authFetch(`/api/contexts/${rootId}/sync`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      if (await waitForRun(authFetch, body.runId) === 'failed') throw new Error('Refresh failed — see the run log.');
      setSyncMsg('Synced');
      setTimeout(() => setSyncMsg(null), 2500);
    });
    setSyncing(false);
  }

  // Drag-drop re-parent: make `childId` a child of `newParentId`. The API
  // validates targetType + cycles and recomputes counts on both branches.
  const reparent = (childId, newParentId) => edit('Move failed', () =>
    sendJson(authFetch, `/api/contexts/${childId}`, 'PATCH', { parentContextId: newParentId }));

  // Drag a member onto another team in the Manager-Hierarchy tree: records an
  // override of who they report to (so it survives plugin re-runs) and moves the
  // membership row immediately.
  const moveMember = (memberId, fromContextId, toContextId) => edit('Move member failed', () =>
    sendJson(authFetch, `/api/contexts/${fromContextId}/members/${memberId}/move`, 'PATCH', { toContextId }));

  const rename = (id, displayName) => edit('Rename failed', () =>
    sendJson(authFetch, `/api/contexts/${id}`, 'PATCH', { displayName }));

  // A new manual child under `parentId`, inheriting the parent's targetType
  // (required to sit in the same tree) and contextType.
  const addChild = (parentId, displayName) => edit('Add child failed', () => {
    const parent = findNodeById(nodes, parentId);
    return sendJson(authFetch, '/api/contexts', 'POST', {
      displayName,
      targetType: parent?.targetType,
      contextType: parent?.contextType || 'Manual',
      parentContextId: parentId,
    });
  });

  // Lazy-load a context's direct members — shown nested inside a node only
  // when the analyst expands it.
  async function loadMembers(ctxId) {
    const r = await authFetch(`/api/contexts/${ctxId}/members?limit=200`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    return { rows: body.data || [], total: body.total || 0 };
  }

  // Delete an entire tree (root + all descendants via ON DELETE CASCADE).
  // Manual + generated allowed; synced is rejected by the API.
  async function deleteTree(rootId) {
    setDeleteError(null);
    try {
      const r = await authFetch(`/api/contexts/${rootId}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 204) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      onTreeDeleted?.(rootId);
    } catch (err) {
      setDeleteError(err.message || 'Delete failed');
    }
  }

  return { editError, deleteError, syncing, syncMsg, syncTree, reparent, moveMember, rename, addChild, loadMembers, deleteTree };
}
