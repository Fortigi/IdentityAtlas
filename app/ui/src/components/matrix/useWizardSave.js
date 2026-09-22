// The state and the actions of the Matrix wizard's Save & share step (#1202).
//
// Every decision — what the button says, what a click does, when the name is
// refused, what is sent — is a pure function in saveStepState.js / shareState.js.
// This hook holds the fields and runs the requests in order: save (POST or PUT),
// then share, then show the saved matrix tagged with its id so the strip above
// the grid names it.
//
// SHARING SAVES THE MATRIX BY ITSELF. Picking the first person used to do
// nothing until the primary button was pressed, and the link it produced was
// never shown — the author had to save, reopen the wizard and come back to the
// share step to find it. So naming the first recipient now writes the matrix
// (under a generated name when none was typed — see nameForShare) and creates
// the share immediately, which is what puts the link on screen: the step swaps
// to the live share panel the moment there is one.

import { useState } from 'react';
import {
  isDirty, primaryAction, nameProblem, savedMatrixBody, copyNameOf, detachesFromSaved,
  nameForShare,
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

  // POST a new matrix / PUT the edited one, under the name given.
  function writeMatrix(useName) {
    const body = savedMatrixBody({ name: useName, description, filter: committed, managed });
    if (!editing || copy) {
      return sendJson(authFetch, '/api/matrix/saved-filters', { body, fallback: 'Could not save the matrix' });
    }
    return sendJson(authFetch, `/api/matrix/saved-filters/${editing.id}`, { method: 'PUT', body, fallback: 'Could not save the matrix' });
  }

  // Write the matrix, or — when only sharing an unchanged one — hand back the
  // row being edited.
  function persist() {
    if (action.kind === 'create' || action.kind === 'update') return writeMatrix(name);
    return Promise.resolve(editing);
  }

  function shareTo(saved, people) {
    return sendJson(authFetch, '/api/matrix/shares', {
      body: shareRequestBody({ savedFilterId: saved.id, recipients: people }),
      fallback: 'Saved, but could not share the matrix',
    });
  }

  async function shareSaved(saved) {
    if (recipients.length === 0) return;
    await shareTo(saved, recipients);
    dialog?.toast?.(`“${saved.name}” saved. ${sharedWithLabel(recipients.length)}.`, { variant: 'success' });
  }

  // The saved matrix a share can hang on: the one being edited when it is
  // already saved and unchanged, else a write under the typed name — or a
  // generated one, put into the field so the author sees what their matrix is
  // now called org-wide and can rename it.
  async function saveForShare() {
    if (editing && !copy && !dirty) return editing;
    for (let attempt = 0; ; attempt++) {
      const chosen = nameForShare({ name, attempt });
      if (chosen.generated) setNameDraft(chosen.name);
      try {
        return await writeMatrix(chosen.name);
      } catch (err) {
        // A GENERATED name that is already taken is not the author's problem to
        // fix: generate the next one, once. A name they typed is theirs, and
        // comes back to them on the field.
        if (attempt === 0 && chosen.generated && isNameClash(err)) continue;
        throw err;
      }
    }
  }

  // Picking people IS sharing (see the header): save the matrix if it needs
  // saving, create the share, and hand back a row that knows it is shared — the
  // step then renders the live share panel, link included.
  async function shareWith(people) {
    setRecipients(people);
    setNameError(null);
    setError(null);
    if (people.length === 0 || busy) return;
    setBusy(true);
    try {
      const saved = await saveForShare();
      // From here on the matrix exists: a failed share must not make a retry
      // POST it a second time, so the wizard now edits the saved row.
      setCopy(false);
      onSaved(saved);
      await shareTo(saved, people);
      onSaved({ ...saved, shared: true, recipientCount: people.length });
      setRecipients([]);
      dialog?.toast?.(`“${saved.name}” saved. ${sharedWithLabel(people.length)}.`, { variant: 'success' });
    } catch (err) {
      if (isNameClash(err)) setNameError(err.message);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
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
    recipients, setRecipients: shareWith,
    copy,
    startCopy: () => { setCopy(true); setNameDraft(copyNameOf(editing?.name)); setNameError(null); },
    cancelCopy: () => { setCopy(false); setNameDraft(null); setNameError(null); },
    nameError, error, busy, action, dirty,
    reset, submit,
  };
}
