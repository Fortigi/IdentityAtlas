// Context builder, users recipe — the organisation entities the terms find (a customer, a
// project, a team) whose linked users join the context. Each can be kept out, or put back.

import { MUTED } from '@ui/components/reports/ask/AskAssistant.styles';
import { orgRowAction } from './recipeDraft';
import { CELL, CHIP, MatchTable, NAME_BUTTON, ROW_BUTTON, StatusBadge, SUBHEAD } from './MatchTable';

const TYPE_CHIP = `${CHIP} bg-violet-50 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300`;
const TERM_CHIP = `${CHIP} bg-sky-50 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300`;

function OrgRow({ o, onChoose, onOpenDetail }) {
  const action = orgRowAction(o.state);
  return (
    <tr className="align-top">
      <td className={CELL}><span className={TYPE_CHIP}>{o.entityType}</span></td>
      <td className={CELL}>
        <button type="button" className={NAME_BUTTON} onClick={() => onOpenDetail?.('org-entity', o.id, o.label)}>{o.label}</button>
        <StatusBadge status={o.state} />
      </td>
      <td className={CELL}>{(o.termKeys || []).map(k => <span key={k} className={TERM_CHIP}>{k}</span>)}</td>
      <td className={`${CELL} text-xs text-gray-600 dark:text-gray-400`}>{o.linkedPrincipals} {o.linkedPrincipals === 1 ? 'user' : 'users'}</td>
      <td className={`${CELL} text-right`}>
        <button type="button" className={ROW_BUTTON} aria-label={`${action.label} ${o.label}`} onClick={() => onChoose(o.id, action.choice)}>{action.label}</button>
      </td>
    </tr>
  );
}

/**
 * @param {object}   props
 * @param {Array}    props.orgMatches  evaluate's orgMatches
 * @param {Function} props.onChoose    (entityId, 'include'|'exclude'|'auto')
 * @param {Function} [props.onOpenDetail]
 */
export default function OrgMatchesBlock({ orgMatches, onChoose, onOpenDetail }) {
  const kept = orgMatches.filter(o => o.state !== 'excluded').length;
  return (
    <section aria-label="Matched organisation entities" className="space-y-2">
      <h4 className={SUBHEAD}>Organisation entities the terms find</h4>
      <p className={MUTED}>{kept} of {orgMatches.length} kept; the users linked to them (owner, team, activity) join the context.</p>
      <MatchTable
        label="Organisation entities" headers={['Type', 'Name', 'Found by', 'Linked', '']} rows={orgMatches}
        renderRow={o => <OrgRow key={o.id} o={o} onChoose={onChoose} onOpenDetail={onOpenDetail} />}
      />
    </section>
  );
}
