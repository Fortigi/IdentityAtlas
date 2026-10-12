// One statement: subject → predicate (qualifier) → object, its modality /
// support / status, the exact quotes, and the reviewer's buttons. Accept and
// Reject send the status the reviewer saw as expectedStatus, so a statement
// someone else already decided is refused (409) instead of overwritten. Edit
// changes the predicate and qualifier and keeps the status. Each side can be
// renamed (MentionSide); the score sits under the badges (StatementScore).
//
// Props: { claim, passages, canEdit, busy, onDecide(claim, body), onRename(mentionId, body) }
import { useState } from 'react';
import { pillColorClass } from '@ui/components/orgtruth/orgFormat';
import { StatusPill, INPUT, SMALL_BUTTON } from '@ui/components/orgtruth/orgUi';
import { PREDICATES, predicateLabel, modalityColor, supportColor } from './knowledgeFormat';
import EvidenceQuote from './EvidenceQuote';
import MentionSide from './MentionSide';
import StatementScore from './StatementScore';

function Pill({ color, children }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${pillColorClass(color)}`}>{children}</span>;
}

function EditForm({ claim, onSave, onCancel }) {
  const [predicate, setPredicate] = useState(claim.predicate);
  const [qualifier, setQualifier] = useState(claim.qualifier ?? '');
  const id = `stmt-${claim.id}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={`${id}-p`} className="text-xs text-gray-700 dark:text-gray-300">Predicate</label>
      <select id={`${id}-p`} className={INPUT} value={predicate} onChange={e => setPredicate(e.target.value)}>
        {PREDICATES.map(p => <option key={p} value={p}>{predicateLabel(p)}</option>)}
      </select>
      <label htmlFor={`${id}-q`} className="text-xs text-gray-700 dark:text-gray-300">Qualifier</label>
      <input id={`${id}-q`} className={INPUT} maxLength={60} value={qualifier} onChange={e => setQualifier(e.target.value)} />
      <button type="button" className={SMALL_BUTTON} onClick={() => onSave({ predicate, qualifier })}>Save</button>
      <button type="button" className={SMALL_BUTTON} onClick={onCancel}>Cancel</button>
    </div>
  );
}

function Actions({ claim, busy, onDecide, onEdit }) {
  const decide = (status) => onDecide(claim, { status, expectedStatus: claim.status });
  return (
    <div className="flex flex-wrap gap-2">
      {claim.status !== 'accepted' && <button type="button" disabled={busy} className={SMALL_BUTTON} onClick={() => decide('accepted')}>Accept</button>}
      {claim.status !== 'rejected' && <button type="button" disabled={busy} className={SMALL_BUTTON} onClick={() => decide('rejected')}>Reject</button>}
      {claim.status !== 'proposed' && <button type="button" disabled={busy} className={SMALL_BUTTON} onClick={() => decide('proposed')}>Back to proposed</button>}
      <button type="button" disabled={busy} className={SMALL_BUTTON} onClick={onEdit}>Edit</button>
    </div>
  );
}

export default function StatementRow({ claim, passages, canEdit, busy, onDecide, onRename }) {
  const [editing, setEditing] = useState(false);
  const save = async (edits) => {
    setEditing(false);
    await onDecide(claim, { status: claim.status, expectedStatus: claim.status, ...edits });
  };
  return (
    <li className="space-y-2 py-3" aria-label={`${claim.subject?.label} ${predicateLabel(claim.predicate)} ${claim.object?.label}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <MentionSide side={claim.subject} canEdit={canEdit} onRename={onRename} />
        <span aria-hidden="true">→</span>
        <span className="italic">{predicateLabel(claim.predicate)}{claim.qualifier ? ` (${claim.qualifier})` : ''}</span>
        <span aria-hidden="true">→</span>
        <MentionSide side={claim.object} canEdit={canEdit} onRename={onRename} />
      </div>
      <div className="flex flex-wrap gap-1">
        <Pill color={modalityColor(claim.modality)}>{claim.modality ?? 'stated'}</Pill>
        <Pill color={supportColor(claim.support)}>{claim.support ?? 'unclear'}</Pill>
        <StatusPill status={claim.status} />
        {claim.rejectedBy === 'verifier' && <Pill color="red">rejected by the verifier</Pill>}
        {claim.edited && <Pill color="blue">edited</Pill>}
      </div>
      <StatementScore claim={claim} />
      {(claim.evidence ?? []).map(ev => <EvidenceQuote key={ev.id} evidence={ev} passages={passages} />)}
      {canEdit && (editing
        ? <EditForm claim={claim} onSave={save} onCancel={() => setEditing(false)} />
        : <Actions claim={claim} busy={busy} onDecide={onDecide} onEdit={() => setEditing(true)} />)}
    </li>
  );
}
