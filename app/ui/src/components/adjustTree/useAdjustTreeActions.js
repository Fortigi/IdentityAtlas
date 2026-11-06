import { useDialog } from '@ui/components/dialogContext';
import { doneText } from './adjustTree.helpers';

// What the screen's buttons and drops do, on top of the data hook: run the
// write, then say what happened in a toast — with Undo, which takes back every
// adjustment the action made (newest first) — or show the API's refusal.
// Each handler resolves to true when the write went through, so a form can
// close itself.

export function useAdjustTreeActions(data, { select }) {
  const dialog = useDialog();

  async function undoAll(list) {
    try {
      for (const a of [...list].reverse()) await data.undo(a.id);
      dialog.toast('Undone', { variant: 'success' });
    } catch (err) {
      dialog.alert(err.message || 'Undo failed');
    }
  }

  // Run a write that makes adjustments; toast with Undo.
  async function change(work, op) {
    try {
      const result = await work();
      const list = (Array.isArray(result) ? result : [result]).filter(a => a?.id != null);
      dialog.toast(doneText(list[0], op), {
        variant: 'success',
        action: list.length ? { label: 'Undo', onClick: () => undoAll(list) } : undefined,
      });
      return true;
    } catch (err) {
      dialog.alert(err.message || 'The change was not saved');
      return false;
    }
  }

  // Run a write on an existing adjustment (undo / redo / follow); plain toast.
  async function onAdjustment(work, message) {
    try {
      await work();
      dialog.toast(message, { variant: 'success' });
      return true;
    } catch (err) {
      dialog.alert(err.message || 'The change was not saved');
      return false;
    }
  }

  const post = (body) => change(() => data.post(body), body.op);
  const group = (spec) => change(() => data.groupUnits(spec), 'addUnit');

  function drop(result) {
    if (result.error) { dialog.alert(result.error, { variant: 'warning' }); return Promise.resolve(false); }
    return post(result);
  }

  const undo = (adj) => onAdjustment(() => data.undo(adj.id), `Undone: ${adj.description}`);
  const redo = (adj) => onAdjustment(() => data.redo(adj.id), `Redone: ${adj.description}`);
  const follow = (adj) => onAdjustment(() => data.follow(adj.id), 'Now follows the suggestion');

  // The one-click fixes of Needs attention.
  function attention(action) {
    switch (action.type) {
      case 'follow': return onAdjustment(() => data.follow(action.adjustmentId), 'Now follows the suggestion');
      case 'remove': return onAdjustment(() => data.undo(action.adjustmentId), 'Adjustment removed');
      case 'split': return post({ op: 'splitUnit', subjectId: action.subjectId, attribute: action.attribute, value: action.value });
      case 'select': select(action.unitId); return Promise.resolve(true);
      default: return Promise.resolve(false);
    }
  }

  return { post, group, drop, undo, redo, follow, attention };
}
