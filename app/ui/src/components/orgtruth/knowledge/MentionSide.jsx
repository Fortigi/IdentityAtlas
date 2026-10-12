// One side (subject or object) of a statement: the mention's name and type,
// the transcript's own spelling when a reviewer renamed it, and "Rename".
// Props: { side: { mentionId, label, type, originalLabel? }, canEdit, onRename(mentionId, body) }
import { useState } from 'react';
import { TypePill, LINK_BUTTON } from '@ui/components/orgtruth/orgUi';
import { renamedFrom } from './knowledgeFormat';
import MentionEditForm from './MentionEditForm';

export default function MentionSide({ side, canEdit, onRename }) {
  const [editing, setEditing] = useState(false);
  const original = renamedFrom(side);
  if (editing) {
    const save = async (body) => {
      setEditing(false);
      await onRename(side.mentionId, body);
    };
    return <MentionEditForm mention={{ id: side.mentionId, label: side.label, type: side.type }} onSave={save} onCancel={() => setEditing(false)} />;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-medium text-gray-900 dark:text-gray-100">{side?.label ?? '?'}</span>
      {original && <span className="text-xs text-gray-600 dark:text-gray-400">(transcript: {original})</span>}
      <TypePill type={side?.type} />
      {canEdit && side?.mentionId && onRename && (
        <button type="button" className={`${LINK_BUTTON} text-xs`} aria-label={`Rename ${side.label}`} onClick={() => setEditing(true)}>Rename</button>
      )}
    </span>
  );
}
