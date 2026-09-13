// Create-a-share dialog (#1166) — the toolbar's entry point.
//
// Chrome only: the modal frame plus a Cancel/Done footer. Everything about
// what a share IS (name, recipients, the shown-once link) lives in
// ShareMatrixForm, which the wizard's final step renders inline instead.

import { useState } from 'react';
import { Modal, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import ShareMatrixForm from './ShareMatrixForm';

export default function ShareMatrixDialog({ filter, managed, onClose }) {
  const [done, setDone] = useState(false);

  return (
    <Modal
      title={done ? 'Share link created' : 'Share this matrix'}
      onClose={onClose}
      width={560}
      dismissOnBackdrop={false}
    >
      <ShareMatrixForm filter={filter} managed={managed} onCreated={() => setDone(true)} />
      <div className="mt-4 flex justify-end">
        <SecondaryButton onClick={onClose}>{done ? 'Done' : 'Cancel'}</SecondaryButton>
      </div>
    </Modal>
  );
}
