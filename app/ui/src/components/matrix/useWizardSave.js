// The state and the one primary action of the Matrix wizard's Save & share step
// (#1202).
//
// Every decision — what the button says, what a click does, when the name is
// refused, what is sent — is a pure function in saveStepState.js / shareState.js.
// This hook holds the fields and runs the requests in order: save (POST or PUT),
// then share, then show the saved matrix tagged with its id so the strip above
// the grid names it.

import { useState } from 'react';
import {
  isDirty, primaryAction, nameProblem, savedMatrixBody, copyNameOf, detachesFromSaved,
} from './saveStepState';
import { shareRequestBody, sharedWithLabel, tagWithSavedMatrix } from './shareState';
import { sendJson, isNameClash } from './matrixRequests';

// `showAs` is the saved matrix a plain "Show matrix" stays tagged with (see
// appliedSavedMatrix in shareState.js): a changed matrix keeps the tag of the
// one it was opened on, so the strip can say it has unsaved changes.
export function useWizardSave({ authFetch, dialog, editing, savedMatch, showAs, managed, committed, onApply, onSaved }) {
  // null = untouched, so the field follows the matrix being edited (whose row
  // may arrive after the wizard opens) until the analyst types.
  const [nameDraft, setNameDraft] = useState(null);
  const [descriptionDraft, setDescriptionDraft] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [copy, setCopy] = useState(false);
  const [nameError, setNameError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const name = nameDraft ?? (editing?.name || '');
  const description = descriptionDraft ?? (editing?.description || '');
  const dirty = isDirty({ editing, savedMatch, managed, name, description });
  const action = primaryAction({ name, recipientCount: recipients.length, editing, copy, dirty });

  function reset() {
    setNameDraft(null);
    setDescriptionDraft(null);
    setRecipients([]);
    setCopy(false);
    setNameError(null);
    setError(null);
  }

  // Write the matrix, or — when only sharing an unchanged one — hand back the
  // row being edited.
  function persist() {
    const body = savedMatrixBody({ name, description, filter: committed, managed });
    if (action.kind === 'create') {
      return sendJson(authFetch, '/api/matrix/saved-filters', { body, fallback: 'Could not save the matrix' });
    }
    if (action.kind === 'update') {
      return sendJson(authFetch, `/api/matrix/saved-filters/${editing.id}`, { method: 'PUT', body, fallback: 'Could not save the matrix' });
    }
    return Promise.resolve(editing);
  }

  async function shareSaved(saved) {
    if (recipients.length === 0) return;
    await sendJson(authFetch, '/api/matrix/shares', {
      body: shareRequestBody({ savedFilterId: saved.id, recipients }),
      fallback: 'Saved, but could not share the matrix',
    });
    dialog?.toast?.(`“${saved.name}” saved. ${sharedWithLabel(recipients.length)}.`, { variant: 'success' });
  }

  async function submit() {
    const problem = nameProblem(action, { name, editing, copy });
    setNameError(problem);
    setError(null);
    if (problem) return;
    if (action.kind === 'show') {
      onApply(tagWithSavedMatrix(committed, showAs), managed);
      return;
    }
    setBusy(true);
    let saved = null;
    try {
      saved = await persist();
      // From here on the matrix exists: a failed share must not make a retry
      // POST it a second time, so the wizard now edits the saved row.
      setCopy(false);
      onSaved(saved);
      await shareSaved(saved);
      onApply(tagWithSavedMatrix(committed, saved), managed);
    } catch (err) {
      if (!saved && isNameClash(err)) setNameError(err.message);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return {
    name,
    setName: (v) => {
      // Emptied while editing a saved matrix: detach, so the next name is a new
      // matrix (and the description it inherited stays with the old one).
      if (detachesFromSaved({ editing, copy, name: v })) {
        setCopy(true);
        setDescriptionDraft('');
      }
      setNameDraft(v);
      setNameError(null);
    },
    description, setDescription: setDescriptionDraft,
    recipients, setRecipients: (v) => { setRecipients(v); setNameError(null); },
    copy,
    startCopy: () => { setCopy(true); setNameDraft(copyNameOf(editing?.name)); setNameError(null); },
    cancelCopy: () => { setCopy(false); setNameDraft(null); setNameError(null); },
    nameError, error, busy, action, dirty,
    reset, submit,
  };
}
