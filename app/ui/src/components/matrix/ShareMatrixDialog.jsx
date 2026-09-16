// The matrix's sharing dialog (#1166, reworked by #1202) — the chrome around
// SharePanel.
//
// Opened from the Load / Save / Share bar, but owned by AppMain rather than by
// anything inside the matrix: a matrix refetch swaps the whole body for the
// loading pane, and MatrixArea picks a different view component once it knows
// whether the payload is a roll-up. With the dialog anywhere below, an analyst
// mid-way through naming recipients on a slow tenant watched it vanish. This is
// the shallowest level that survives all of it.

import { Modal } from '@ui/components/contexts/ModalPrimitives';
import SharePanel from './SharePanel';

export default function ShareMatrixDialog({ filter, managed, savedFilterId = null, savedName = null, onClose }) {
  return (
    <Modal
      title={savedName ? `Sharing “${savedName}”` : 'Share this matrix'}
      onClose={onClose}
      width={560}
      dismissOnBackdrop={false}
    >
      <SharePanel
        savedFilterId={savedFilterId}
        savedName={savedName}
        filter={filter}
        managed={managed}
        onClose={onClose}
      />
    </Modal>
  );
}
