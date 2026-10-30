import { Modal } from './ModalPrimitives';
import ManualContextEditor from './ManualContextEditor';

// ─── Edit a context ───────────────────────────────────────────────────────
// Opened by the header's Edit button. Contexts created here and derived ones
// are editable — name, description, template, parent, delete; imported ones
// are not (the next import would overwrite the edit), and the header offers
// no Edit for them. Adding a sub-unit is the header's "Add sub-unit", not a
// form in here; the people who answer for the unit are set in its facts card.
//
// onUpdated runs after a save, onDeleted after a delete; the page closes the
// modal on either.

export default function ContextEditModal({ contextId, attrs, onUpdated, onDeleted, onClose }) {
  return (
    <Modal title={`Edit ${attrs.displayName || 'unit'}`} onClose={onClose} width={720} dismissOnBackdrop={false}>
      <ManualContextEditor contextId={contextId} attrs={attrs} onUpdated={onUpdated} onDeleted={onDeleted} />
    </Modal>
  );
}
