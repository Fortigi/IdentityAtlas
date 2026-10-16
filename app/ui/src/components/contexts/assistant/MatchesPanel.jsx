// Context builder — the objects the terms find: exclude one, include one a term does not
// find, and see why each is there. For a users recipe the resources are the first of three
// blocks: the organisation entities the terms find, and the users both lead to, follow.

import { useState } from 'react';
import { MUTED } from '@ui/components/reports/ask/AskAssistant.styles';
import { recipeTarget, rowAction } from './recipeDraft';
import AddByName from './AddByName';
import { CELL, CHIP, MatchTable, NAME_BUTTON, ROW_BUTTON, StatusBadge, SUBHEAD } from './MatchTable';
import OrgMatchesBlock from './OrgMatchesBlock';
import PrincipalsBlock from './PrincipalsBlock';

const VIEWS = [
  { key: 'in', label: 'In the context', statuses: ['member', 'included'] },
  { key: 'excluded', label: 'Excluded', statuses: ['excluded'] },
  { key: 'candidate', label: 'Found only by dropped terms', statuses: ['candidate'] },
];

function HitChips({ hits, fieldLabels }) {
  return hits.map(h => (
    <span key={h.term} title={`in ${h.fields.map(f => fieldLabels[f] || f).join(', ')}`}
      className={`${CHIP} ${h.accepted ? 'bg-sky-50 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'}`}>
      {h.term}{h.fields.includes('displayName') ? '' : ` (${(fieldLabels[h.fields[0]] || h.fields[0]).toLowerCase()})`}
    </span>
  ));
}

function MatchRow({ m, fieldLabels, onChoose, onOpen }) {
  const action = rowAction(m.status);
  return (
    <tr className="align-top">
      <td className={CELL}>
        <button type="button" className={NAME_BUTTON} onClick={() => onOpen(m)}>{m.displayName}</button>
        <StatusBadge status={m.status} />
        {m.description && <div className="max-w-xl truncate text-xs text-gray-500 dark:text-gray-400" title={m.description}>{m.description}</div>}
      </td>
      <td className={`${CELL} text-xs text-gray-600 dark:text-gray-400`}>{m.resourceType}{m.systemName ? ` · ${m.systemName}` : ''}</td>
      <td className={CELL}><HitChips hits={m.hits} fieldLabels={fieldLabels} /></td>
      <td className={`${CELL} text-right`}>
        <button type="button" className={ROW_BUTTON} onClick={() => onChoose(m.id, action.choice)}>{action.label}</button>
      </td>
    </tr>
  );
}

function ResourceMatches({ evaluation, recipe, fieldLabels, onChoose, onOpenDetail }) {
  const [view, setView] = useState('in');
  const matches = evaluation?.matches || [];
  const counts = Object.fromEntries(VIEWS.map(v => [v.key, matches.filter(m => v.statuses.includes(m.status)).length]));
  const shown = matches.filter(m => VIEWS.find(v => v.key === view).statuses.includes(m.status));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="tablist">
        {VIEWS.map(v => (
          <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => setView(v.key)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${view === v.key ? 'bg-blue-600 text-white dark:bg-blue-700' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}`}>
            {v.label} ({counts[v.key]})
          </button>
        ))}
        {evaluation && <span className={MUTED}>of {evaluation.scopeTotal} {recipe.resourceTypes.join(' / ').toLowerCase()} objects in scope</span>}
      </div>
      {evaluation?.truncated && <p className="text-xs text-amber-700 dark:text-amber-300">More objects matched than can be shown; narrow the terms.</p>}
      <MatchTable
        headers={['Name', 'Type', 'Found by', '']} rows={shown}
        renderRow={m => (
          <MatchRow key={m.id} m={m} fieldLabels={fieldLabels} onChoose={onChoose}
            onOpen={row => onOpenDetail?.('resource', row.id, row.displayName)} />
        )}
      />
      <AddByName
        inputId="ctx-add-object" label="Find an object to include by hand" placeholder="Include by name…"
        // Only kinds of object the context searches: anything else would never show up in it.
        accept={f => recipe.resourceTypes.includes(f.type)}
        included={recipe.include} onInclude={id => onChoose(id, 'include')}
      />
    </div>
  );
}

/**
 * @param {object}   props
 * @param {object}   [props.evaluation]  the evaluate answer
 * @param {object}   props.recipe
 * @param {object}   props.fieldLabels
 * @param {Function} props.onChoose      (resourceId, 'include'|'exclude'|'auto')
 * @param {Function} [props.onChooseOrg]       (entityId, choice) — users recipe only
 * @param {Function} [props.onChoosePrincipal] (principalId, choice) — users recipe only
 * @param {Function} props.onOpenDetail
 */
export default function MatchesPanel({ onChooseOrg, onChoosePrincipal, ...props }) {
  if (recipeTarget(props.recipe) !== 'principal') return <ResourceMatches {...props} />;
  return (
    <div className="space-y-6">
      <section aria-label="Matched resources" className="space-y-2">
        <h4 className={SUBHEAD}>Resources the terms find</h4>
        <ResourceMatches {...props} />
      </section>
      <OrgMatchesBlock orgMatches={props.evaluation?.orgMatches || []} onChoose={onChooseOrg} onOpenDetail={props.onOpenDetail} />
      <PrincipalsBlock evaluation={props.evaluation} recipe={props.recipe} onChoose={onChoosePrincipal} onOpenDetail={props.onOpenDetail} />
    </div>
  );
}
