import { PersonSearch } from '@ui/components/contexts/ContextRoleModal';
import { Modal, ErrorBox } from '@ui/components/contexts/ModalPrimitives';
import { subjectLabel } from './claims.helpers';

// Pick the account an interview claim is about, when the name was not matched
// or was matched to the wrong person. onPick(account) resolves to true when the
// claim was confirmed for them; the modal then closes.
export default function ChoosePersonModal({ claim, title, onPick, onClose, error }) {
  return (
    <Modal title={title} subtitle={`The interview said “${subjectLabel(claim)}”`} onClose={onClose} width={440}>
      <div className="text-xs">
        <PersonSearch inputId="interview-choose-person" label="Find the person who was meant"
          onPick={async p => { if (await onPick(p)) onClose(); }} />
      </div>
      <ErrorBox message={error} />
    </Modal>
  );
}
