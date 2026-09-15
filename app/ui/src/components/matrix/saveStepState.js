// The rules behind the Matrix wizard's "Save & share" step (#1202).
//
// A matrix is a document: the wizard's last step either shows it as it stands,
// or keeps it under a name. ONE primary button carries that choice, and its
// label follows what the analyst has filled in — so these rules decide what a
// click actually does. They are pure and mutation-tested (stryker.pilot.config),
// while WizardSaveStep.jsx / useWizardSave.js stay chrome and plumbing.

// The governed-lens values a saved matrix may carry.
export const LENS_VALUES = ['all', 'managed', 'unmanaged', 'gaps'];

// The lens a stored matrix opens with; anything unknown reads as 'all'.
export function lensOf(value) {
  return LENS_VALUES.includes(value) ? value : 'all';
}

const trimmed = (s) => (typeof s === 'string' ? s.trim() : '');

// Has the analyst changed the saved matrix they are editing? The filter itself
// is compared by fingerprint (`savedMatch` is the saved matrix the current
// filter IS), plus the three things a fingerprint does not see: the lens, the
// name and the description.
export function isDirty({ editing, savedMatch, managed, name, description }) {
  if (!editing) return false;
  if (savedMatch?.id !== editing.id) return true;
  if (lensOf(editing.filter?.managed) !== managed) return true;
  if (trimmed(name) !== trimmed(editing.name)) return true;
  return trimmed(description) !== trimmed(editing.description);
}

// What the primary button does, and what it says.
//
//   show      — no name, nobody to share with: apply without saving
//   needName  — people picked but no name: a share needs a saved matrix
//   create    — a new matrix (or a copy of the edited one): POST, then show
//   update    — the edited matrix changed: PUT, then show
//   share     — the edited matrix is unchanged but people were picked
//
// An edited matrix that is unchanged and shared with nobody new has nothing to
// save, so it is just shown — a PUT would tell its recipients about a change
// that is not one.
export function primaryAction({ name, recipientCount = 0, editing = null, copy = false, dirty = false }) {
  if (!trimmed(name)) {
    return recipientCount > 0
      ? { kind: 'needName', label: 'Save & show' }
      : { kind: 'show', label: 'Show matrix' };
  }
  if (!editing || copy) return { kind: 'create', label: 'Save & show' };
  if (dirty) return { kind: 'update', label: 'Save changes & show' };
  if (recipientCount > 0) return { kind: 'share', label: 'Share & show' };
  return { kind: 'show', label: 'Show matrix' };
}

// Does this edit of the name field let go of the saved matrix being edited?
// Emptying the name says "this is not that matrix any more": from there a name
// typed in is a NEW matrix, never a rename that overwrites the one opened —
// the org default included (#1202).
export function detachesFromSaved({ editing = null, copy = false, name }) {
  return !!editing && !copy && !trimmed(name);
}

// Why the name field refuses a click, or null when it doesn't.
export function nameProblem(action, { name, editing = null, copy = false }) {
  if (action.kind === 'needName') return 'Name this matrix to share it';
  if (copy && editing && trimmed(name) === trimmed(editing.name)) {
    return 'Give the copy a different name';
  }
  return null;
}

// The body POSTed / PUT to /api/matrix/saved-filters. The lens is folded into
// the filter, where a saved matrix keeps it; an empty description is stored as
// none rather than as an empty string.
export function savedMatrixBody({ name, description, filter, managed }) {
  return {
    name: trimmed(name),
    description: trimmed(description) || null,
    filter: { ...filter, managed },
  };
}

// The default name offered for a copy — never the original's own name, which
// would only come back as a clash.
export function copyNameOf(name) {
  return `${trimmed(name)} (copy)`;
}
