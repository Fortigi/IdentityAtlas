import { defaultChildCategory } from './ManualContextEditor.helpers';

// Create a sub-unit directly under `parent` (the header's "Add sub-unit"). It
// is created here (manual), holds the same kind of member and keeps the
// parent's type and template, so it sits naturally in the tree. Resolves to
// the created context; throws with the API's message when refused.
export async function addSubUnit(authFetch, parent, name) {
  const r = await authFetch('/api/contexts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: name,
      contextType: parent.contextType || 'Manual',
      contextCategory: defaultChildCategory(parent),
      targetType: parent.targetType,
      parentContextId: parent.id,
    }),
  });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
  return payload;
}

// The header's flow: ask the name (useDialog's prompt), create the sub-unit,
// say why when the API refuses. Resolves to true once one was created.
export async function promptAndAddSubUnit(dialog, authFetch, parent) {
  const name = (await dialog.prompt({ title: 'Add sub-unit', message: `Name of the new unit under ${parent.displayName}`, confirmLabel: 'Add' }))?.trim();
  if (!name) return false;
  try {
    await addSubUnit(authFetch, parent, name);
    return true;
  } catch (err) {
    dialog.alert(err.message || 'Could not add the sub-unit');
    return false;
  }
}
