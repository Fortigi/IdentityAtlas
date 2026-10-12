// Inline "Rename" form of a mention: its name and type. Saving renames the
// mention in every statement of the transcript and matches it again.
// Props: { mention: { id, label, type }, onSave({ label, type }), onCancel() }
import { useState } from 'react';
import { INPUT, SMALL_BUTTON } from '@ui/components/orgtruth/orgUi';
import { MENTION_TYPES, mentionEditBody } from './knowledgeFormat';

export default function MentionEditForm({ mention, onSave, onCancel }) {
  const [label, setLabel] = useState(mention.label ?? '');
  const [type, setType] = useState(mention.type ?? 'concept');
  const id = `mention-${mention.id}`;
  const body = mentionEditBody({ label, type });
  return (
    <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label={`Rename ${mention.label}`}>
      <label htmlFor={`${id}-l`} className="text-xs text-gray-700 dark:text-gray-300">Name</label>
      <input id={`${id}-l`} className={INPUT} maxLength={200} value={label} onChange={e => setLabel(e.target.value)} />
      <label htmlFor={`${id}-t`} className="text-xs text-gray-700 dark:text-gray-300">Type</label>
      <select id={`${id}-t`} className={INPUT} value={type} onChange={e => setType(e.target.value)}>
        {MENTION_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <button type="button" className={SMALL_BUTTON} disabled={!body.label} onClick={() => onSave(body)}>Save</button>
      <button type="button" className={SMALL_BUTTON} onClick={onCancel}>Cancel</button>
    </span>
  );
}
