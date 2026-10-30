import { useState } from 'react';
import { toSavePayload, draftFromSaved, viewFromSaved, fingerprint, accessChanges, roleFingerprint } from './workbench.save';

// Save and reopen (M2a): the investigation the workbench is on, if any, and the
// requests that save, open, list and delete one. `saved` remembers what was
// saved — its id, name, who and when, the cells on screen then, and a fingerprint
// of the work — so the page can say "unsaved changes" and how much the access
// data changed since. The pure parts are in workbench.save.js.

// roles: each saved proposed role's own fingerprint, so one role can say "Saved" while another is new.
const summaryOf = (inv, view, work) => ({
  id: inv.id, name: inv.name, updatedAt: inv.updatedAt, updatedBy: inv.updatedBy,
  accessCells: inv.accessCells ?? [], fingerprint: fingerprint(view, work),
  roles: new Map(work.drafts.map(d => [d.id, roleFingerprint(d)])),
});

/**
 * @param {object} args
 * @param {string} args.contextId   the unit
 * @param {Function} args.send      (url, method, body) → JSON, throws with the API's error
 * @param {object} args.view        the workbench view
 * @param {Function} args.setView
 * @param {object} args.draft       the draft state (marks, drafts, …)
 * @param {Function} args.dispatch  the draft reducer's dispatch
 * @param {object|null} args.data   the workbench data on screen
 * @param {object} args.defaultView the view a saved one is laid over
 */
export function useInvestigation({ contextId, send, view, setView, draft, dispatch, data, defaultView }) {
  const [saved, setSaved] = useState(null);
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async (fn) => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (err) { setError(err.message); return null; } finally { setBusy(false); }
  };

  // After a save: the proposed roles now carry their saved ids; the view stays as it is.
  const afterSave = (inv) => {
    const work = draftFromSaved(inv);
    dispatch({ type: 'loadSaved', ...work, keep: true });
    setSaved(summaryOf(inv, view, work));
    setList(null);
    return inv;
  };

  const saveAs = (name) => run(async () => afterSave(await send(
    `/api/contexts/${contextId}/workbench/investigations`, 'POST', toSavePayload({ view, data, draft, name }))));

  const save = () => (saved ? run(async () => afterSave(await send(
    `/api/workbench/investigations/${saved.id}`, 'PUT', toSavePayload({ view, data, draft, expectedUpdatedAt: saved.updatedAt })))) : null);

  const open = (id) => run(async () => {
    const inv = await send(`/api/workbench/investigations/${id}`, 'GET');
    const nextView = viewFromSaved(inv.view, defaultView);
    const work = draftFromSaved(inv);
    setView(nextView);
    dispatch({ type: 'loadSaved', ...work, keep: false });
    setSaved(summaryOf(inv, nextView, work));
    return inv;
  });

  const loadList = () => run(async () => {
    const body = await send(`/api/contexts/${contextId}/workbench/investigations`, 'GET');
    setList(body.data ?? []);
    return body.data;
  });

  const remove = (id) => run(async () => {
    await send(`/api/workbench/investigations/${id}`, 'DELETE');
    if (saved?.id === id) setSaved(null);
    setList(l => (l ? l.filter(i => i.id !== id) : l));
    return true;
  });

  const hasWork = draft.drafts.length > 0 || draft.marks.size > 0;
  const dirty = saved ? fingerprint(view, draft) !== saved.fingerprint : hasWork;
  const changedCells = saved && data ? accessChanges(saved.accessCells, data.cells) : 0;

  return { saved, list, busy, error, dirty, changedCells, save, saveAs, open, loadList, remove, clearError: () => setError(null) };
}
