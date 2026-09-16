// Pure helpers for ManualContextEditor — kept in a non-component module so the
// editor stays small and the dirty-check logic can be unit-tested directly.

// The loaded attrs with editable fields normalised to the editor's string form
// ('' for absent). Used both to seed the form state and to reset it when a
// different context opens in the tab.
export function normalizeContextFields(attrs) {
  return {
    displayName: attrs.displayName || '',
    description: attrs.description || '',
    ownerUserId: attrs.ownerUserId || '',
    parentId: attrs.parentContextId || '',
    parentLabel: attrs.parentDisplayName || '',
  };
}

// True when any editable field diverges from the loaded attrs. parentId is
// compared as a nullable id ('' and null both mean "no parent — root").
export function isContextDirty(attrs, { displayName, description, ownerUserId, parentId }) {
  const base = normalizeContextFields(attrs);
  return (
    displayName !== base.displayName ||
    description !== base.description ||
    ownerUserId !== base.ownerUserId ||
    (parentId || null) !== (attrs.parentContextId || null)
  );
}
