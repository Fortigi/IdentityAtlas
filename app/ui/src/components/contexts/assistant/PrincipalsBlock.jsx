// Context builder, users recipe — the users the context will hold: the total, a list with
// why each is there ("member of …", "Klant … "), and adding or removing one by hand.

import { MUTED, SECONDARY } from '@ui/components/reports/ask/AskAssistant.styles';
import { rowAction, viaText } from './recipeDraft';
import AddByName from './AddByName';
import { CELL, CHIP, MatchTable, NAME_BUTTON, ROW_BUTTON, StatusBadge, SUBHEAD } from './MatchTable';

const VIA_CHIP = {
  access: `${CHIP} bg-sky-50 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300`,
  org: `${CHIP} bg-violet-50 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300`,
};

function PrincipalRow({ p, handAdded, onChoose, onOpenDetail }) {
  const status = handAdded ? 'included' : 'member';
  const action = rowAction(status);
  return (
    <tr className="align-top">
      <td className={CELL}>
        <button type="button" className={NAME_BUTTON} onClick={() => onOpenDetail?.('user', p.id, p.displayName)}>{p.displayName}</button>
        <StatusBadge status={status} />
        {p.upn && <div className="text-xs text-gray-500 dark:text-gray-400">{p.upn}</div>}
      </td>
      <td className={`${CELL} text-xs text-gray-600 dark:text-gray-400`}>{p.principalType}</td>
      <td className={CELL}>
        {(p.via || []).map((v, i) => <span key={i} className={VIA_CHIP[v.kind] || VIA_CHIP.access}>{viaText(v)}</span>)}
      </td>
      <td className={`${CELL} text-right`}>
        <button type="button" className={ROW_BUTTON} aria-label={`${action.label} ${p.displayName}`} onClick={() => onChoose(p.id, action.choice)}>{action.label}</button>
      </td>
    </tr>
  );
}

/**
 * @param {object}   props
 * @param {object}   [props.evaluation]  evaluate's answer; reads `principals`
 * @param {object}   props.recipe        reads principalInclude / principalExclude
 * @param {Function} props.onChoose      (principalId, 'include'|'exclude'|'auto')
 * @param {Function} [props.onOpenDetail]
 */
export default function PrincipalsBlock({ evaluation, recipe, onChoose, onOpenDetail }) {
  const total = evaluation?.principals?.total ?? 0;
  const sample = evaluation?.principals?.sample || [];
  const included = recipe.principalInclude || [];
  const excluded = recipe.principalExclude || [];
  return (
    <section aria-label="Resulting users" className="space-y-2">
      <h4 className={SUBHEAD}>Users in the context <span className="font-normal">— {total} {total === 1 ? 'user' : 'users'}</span></h4>
      {sample.length < total && <p className={MUTED}>Showing {sample.length} of {total}, by name.</p>}
      <MatchTable
        label="Users" headers={['Name', 'Type', 'Why', '']} rows={sample}
        renderRow={p => <PrincipalRow key={p.id} p={p} handAdded={included.includes(p.id)} onChoose={onChoose} onOpenDetail={onOpenDetail} />}
      />
      {excluded.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className={MUTED}>{excluded.length} removed by hand</span>
          <button type="button" className={SECONDARY} onClick={() => excluded.forEach(id => onChoose(id, 'auto'))}>Put them back</button>
        </div>
      )}
      <AddByName
        inputId="ctx-add-user" label="Find a user to add by hand" placeholder="Add a user by name…" kind="principal"
        included={included} onInclude={id => onChoose(id, 'include')}
      />
    </section>
  );
}
