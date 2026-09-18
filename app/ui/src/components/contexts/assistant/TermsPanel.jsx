// Context builder — the search terms: keep or drop each one while seeing what it finds,
// change how it matches, add your own.

import { useState } from 'react';
import { MUTED, SECONDARY } from '@ui/components/reports/ask/AskAssistant.styles';
import { MATCH_LABELS, termCounts, widenWarning } from './recipeDraft';
import RelatedWords from './RelatedWords';

const INPUT = 'rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100';

// What the numbers mean, per term state:
//   kept    "12 found · 3 only by this term"   (what dropping it would lose)
//   dropped "12 found · 3 not found otherwise" (what keeping it would add)
function hitText(stats, kept) {
  if (!stats) return '…';
  if (stats.hits === 0) return 'finds nothing';
  const unique = kept ? `${stats.unique} only by this term` : `${stats.unique} not found otherwise`;
  return `${stats.hits} found · ${unique}`;
}

function fieldText(stats, fieldLabels) {
  if (!stats?.hits) return '';
  return Object.entries(stats.byField)
    .filter(([, n]) => n > 0)
    .map(([f, n]) => `${n} in ${(fieldLabels[f] || f).toLowerCase()}`)
    .join(', ');
}

function TermRow({ term, stats, fieldLabels, onToggle, onMatch, onRemove }) {
  const kept = term.state === 'accepted';
  const id = `term-${term.key.replace(/ /g, '-')}`;
  return (
    <li className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 ${kept ? '' : 'opacity-70'}`}>
      <input id={id} type="checkbox" checked={kept} onChange={() => onToggle(term.key)} className="h-4 w-4" />
      <label htmlFor={id} className={`min-w-[8rem] text-sm font-medium ${kept ? 'text-gray-900 dark:text-white' : 'text-gray-500 line-through dark:text-gray-400'}`}>
        {term.text}
      </label>
      {term.why && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600 dark:bg-gray-700 dark:text-gray-300">{term.why}</span>}
      {term.origin === 'model' && !term.own && (
        <span className="text-[11px] text-violet-700 dark:text-violet-300" title="Proposed by the model; does not contain your own words">suggested</span>
      )}
      <span className="text-xs text-gray-700 dark:text-gray-300">{hitText(stats, kept)}</span>
      {stats?.tooBroad && (
        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" title="This term finds a large share of everything in scope">very broad</span>
      )}
      <span className={MUTED}>{fieldText(stats, fieldLabels)}</span>
      <span className="ml-auto flex items-center gap-2">
        <label className="sr-only" htmlFor={`${id}-match`}>How “{term.text}” matches</label>
        <select id={`${id}-match`} value={term.match} onChange={e => onMatch(term.key, e.target.value)} className={INPUT}>
          {Object.entries(MATCH_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <button type="button" onClick={() => onRemove(term.key)} className="text-sm text-gray-500 hover:text-red-600 dark:text-gray-400" aria-label={`Remove ${term.text}`}>✕</button>
      </span>
    </li>
  );
}

/**
 * @param {object}   props
 * @param {object}   props.recipe
 * @param {object[]} [props.stats]        evaluation.terms
 * @param {object}   [props.evaluation]   the evaluate answer, for the widening warning
 * @param {object}   props.fieldLabels    field name → label
 * @param {object}   props.actions        { toggle, match, remove, add, addRelated }
 * @param {number}   props.memberCount    objects in the context now (related words need some)
 */
export default function TermsPanel({ recipe, stats = [], evaluation, fieldLabels, actions, memberCount = 0 }) {
  const [text, setText] = useState('');
  const widened = widenWarning(evaluation);
  const byKey = new Map(stats.map(s => [s.key, s]));
  const { kept, dropped } = termCounts(recipe);

  const add = (e) => {
    e.preventDefault();
    actions.add(text);
    setText('');
  };

  return (
    <div className="space-y-2">
      {recipe.terms.length > 0 ? (
        <>
          <p className={MUTED}>{kept} kept · {dropped} dropped. A group is in the context when a kept term matches its {recipe.fields.map(f => (fieldLabels[f] || f).toLowerCase()).join(' or ')}.</p>
          {widened && (
            <p role="alert" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
              The terms the model suggested bring in {widened.added} groups; your own words find {widened.rest}. Check that the suggested terms really are about this subject — the model may be guessing what a name means.
            </p>
          )}
          <ul className="divide-y divide-gray-100 rounded border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
            {recipe.terms.map(t => (
              <TermRow key={t.key} term={t} stats={byKey.get(t.key)} fieldLabels={fieldLabels}
                onToggle={actions.toggle} onMatch={actions.match} onRemove={actions.remove} />
            ))}
          </ul>
        </>
      ) : (
        <p className={MUTED}>No search terms yet. Describe the context above, or type a term.</p>
      )}
      <form onSubmit={add} className="flex flex-wrap items-center gap-2">
        <label htmlFor="ctx-add-term" className="sr-only">Add a search term</label>
        <input id="ctx-add-term" value={text} onChange={e => setText(e.target.value)} placeholder="Add a term, e.g. inkoop" className={INPUT} />
        <button type="submit" className={SECONDARY} disabled={!text.trim()}>Add term</button>
      </form>
      <RelatedWords recipe={recipe} disabled={memberCount === 0} onAdd={actions.addRelated} />
    </div>
  );
}
