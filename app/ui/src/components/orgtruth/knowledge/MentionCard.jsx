// One mention (who or what the transcript talks about) and the objects it may
// be: each candidate with its confidence and why it matched, Confirm / Reject /
// Reset, and "Choose another…" to pick a different object by hand. A mention
// without any candidate says so and offers "Choose…" on the mention itself.
// "Rename" corrects the name or type (every statement follows); a renamed
// mention shows what the transcript said.
//
// Props: { mention, canEdit, busy, onMatch(linkId, body), onChooseFor(mentionId, body), onRename(mentionId, body), onOpenDetail }
import { useState } from 'react';
import { targetDetailKind, targetTypeLabel } from '@ui/components/orgtruth/orgFormat';
import { StatusPill, TypePill, CARD, SMALL_BUTTON, LINK_BUTTON } from '@ui/components/orgtruth/orgUi';
import { resolutionText, matchReasons, renamedFrom } from './knowledgeFormat';
import ChooseObject from './ChooseObject';
import MentionEditForm from './MentionEditForm';

const OPEN_RESOLUTION = 'text-xs font-medium text-amber-700 dark:text-amber-300';
const QUIET = 'text-xs text-gray-600 dark:text-gray-400';

function CandidateName({ candidate, onOpenDetail }) {
  const kind = targetDetailKind(candidate.targetType) ?? (candidate.targetType === 'OrgEntity' ? 'org-entity' : null);
  const name = candidate.label ?? candidate.targetId;
  if (!kind || !onOpenDetail) return <span className="font-medium">{name}</span>;
  return <button type="button" className={LINK_BUTTON} onClick={() => onOpenDetail(kind, candidate.targetId, name)}>{name}</button>;
}

function Candidate({ candidate, mention, canEdit, busy, onMatch, onOpenDetail }) {
  const act = (action) => onMatch(candidate.linkId, { action });
  const name = candidate.label ?? candidate.targetId;
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2">
      <div className="text-sm text-gray-700 dark:text-gray-300">
        <CandidateName candidate={candidate} onOpenDetail={onOpenDetail} />
        <span className={`ml-2 ${QUIET}`}>{[targetTypeLabel(candidate.targetType), candidate.kind].filter(Boolean).join(' · ')}</span>
        <span className="ml-2 font-medium">{candidate.confidence}%</span>
        <span className="ml-2"><StatusPill status={candidate.status} /></span>
        {matchReasons(candidate) && <div className={QUIET}>Why: {matchReasons(candidate)}</div>}
      </div>
      {canEdit && (
        <div className="flex gap-2">
          {candidate.status !== 'accepted' && <button type="button" disabled={busy} className={SMALL_BUTTON} aria-label={`Confirm ${name} for ${mention.label}`} onClick={() => act('confirm')}>Confirm</button>}
          {candidate.status !== 'rejected' && <button type="button" disabled={busy} className={SMALL_BUTTON} aria-label={`Reject ${name} for ${mention.label}`} onClick={() => act('reject')}>Reject</button>}
          {candidate.status !== 'proposed' && <button type="button" disabled={busy} className={SMALL_BUTTON} aria-label={`Reset ${name} for ${mention.label}`} onClick={() => act('reset')}>Reset</button>}
        </div>
      )}
    </li>
  );
}

function Heading({ mention, canEdit, busy, onRename }) {
  const [renaming, setRenaming] = useState(false);
  const original = renamedFrom(mention);
  if (renaming) {
    const save = async (body) => {
      setRenaming(false);
      await onRename(mention.id, body);
    };
    return <MentionEditForm mention={mention} onSave={save} onCancel={() => setRenaming(false)} />;
  }
  return (
    <>
      <span className="font-medium text-gray-900 dark:text-gray-100">{mention.label}</span>
      <TypePill type={mention.type} />
      {original && <span className={QUIET}>transcript said: {original}</span>}
      {canEdit && onRename && (
        <button type="button" disabled={busy} className={`${LINK_BUTTON} text-xs`} aria-label={`Rename ${mention.label}`} onClick={() => setRenaming(true)}>Rename</button>
      )}
    </>
  );
}

export default function MentionCard({ mention, canEdit, busy, onMatch, onChooseFor, onRename, onOpenDetail }) {
  const [choosing, setChoosing] = useState(false);
  const candidates = mention.candidates ?? [];
  const anchor = candidates[0]?.linkId;
  const open = mention.resolution !== 'candidates' || candidates.length === 0;
  const choose = async (c) => {
    setChoosing(false);
    const target = { targetType: c.targetType, targetId: c.targetId };
    if (anchor) await onMatch(anchor, { action: 'choose', ...target });
    else await onChooseFor(mention.id, target);
  };
  const canChoose = canEdit && Boolean(anchor || onChooseFor) && !choosing;

  return (
    <section className={`${CARD} p-3`} aria-label={`Mention ${mention.label}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Heading mention={mention} canEdit={canEdit} busy={busy} onRename={onRename} />
        <span className={open ? OPEN_RESOLUTION : QUIET}>{resolutionText(mention.resolution)}</span>
        <span className={QUIET}>{(mention.occurrences ?? []).length}× in the transcript</span>
      </div>
      {candidates.length === 0
        ? <p className={`mt-1 ${QUIET}`}>No existing object matches this mention.</p>
        : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {candidates.map(c => (
              <Candidate key={c.linkId} candidate={c} mention={mention} canEdit={canEdit} busy={busy} onMatch={onMatch} onOpenDetail={onOpenDetail} />
            ))}
          </ul>
        )}
      {canChoose && (
        <button type="button" className={`${SMALL_BUTTON} mt-2`} onClick={() => setChoosing(true)}>{anchor ? 'Choose another…' : 'Choose…'}</button>
      )}
      {choosing && <ChooseObject type={mention.type} label={mention.label} onChoose={choose} onCancel={() => setChoosing(false)} />}
    </section>
  );
}
