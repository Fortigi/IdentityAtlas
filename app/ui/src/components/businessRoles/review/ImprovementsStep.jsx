import { DECISIONS, DECISION_INFO, decisionsVerdict, suggestionText } from './improvementSteps';

// ─── The improvements step of the review wizard ──────────────────────────
// What role mining suggests for the role, each with how sure it is and why, and
// the reviewer's decision on each: propose it, not for this role, or "I do not
// understand". When nothing is suggested the step says so plainly: role mining
// shows only what it is at least 95% sure of, and found nothing that sure.

const MUTED = 'text-sm text-gray-600 dark:text-gray-400';
const BOX = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800';
const CHOICE = 'flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm';
const CHOSEN = 'border-blue-600 bg-blue-50 text-gray-900 dark:border-blue-400 dark:bg-blue-900/30 dark:text-white';
const IDLE = 'border-gray-300 text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700/50';

export function ConfidenceChip({ confidence }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-200">
      {confidence}% sure
    </span>
  );
}

function Nothing({ found }) {
  const few = found.holderCount < found.thresholds?.holders;
  return (
    <div className={BOX} data-testid="improvements-none">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Role mining found no improvements for this role.</p>
      <p className={`${MUTED} mt-1`}>
        It suggests only what it is at least {found.thresholds?.confidence ?? 95}% sure of: a permission everyone who holds the role has and
        nobody else has, a new permission that comes close to that, or, for a role handed out by hand, a rule that would hand it out to
        exactly the right people. Nothing came that close.
      </p>
      {few && <p className={`${MUTED} mt-1`}>With fewer than {found.thresholds.holders} people holding the role there is too little to go on.</p>}
    </div>
  );
}

function Suggestion({ suggestion, decision, onDecide }) {
  const { title, why } = suggestionText(suggestion);
  return (
    <fieldset aria-label={title} className={`${BOX} space-y-3`} data-testid={`suggestion-${suggestion.key}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</p>
        <ConfidenceChip confidence={suggestion.confidence} />
      </div>
      <p className="text-sm text-gray-800 dark:text-gray-200">{why}</p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {DECISIONS.map(d => (
          <label key={d} className={`${CHOICE} ${decision === d ? CHOSEN : IDLE}`}>
            <input type="radio" name={`decision-${suggestion.key}`} value={d} checked={decision === d} onChange={() => onDecide(d)} className="mt-0.5" />
            <span>{DECISION_INFO[d].label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function ImprovementsStep({ found, loading, error, onRetry, answer, onChange }) {
  if (loading || (!found && !error)) return <p className={MUTED}>Role mining is looking for improvements…</p>;
  if (error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-700 dark:text-red-400">
        Could not look for improvements.
        <button type="button" onClick={onRetry} className="rounded border border-red-300 px-2 py-1 text-xs hover:bg-red-50 dark:border-red-700 dark:hover:bg-red-900/30">Try again</button>
      </div>
    );
  }
  const verdict = decisionsVerdict(answer.decisions);
  const asks = Object.values(answer.decisions).includes('notUnderstood');
  const decide = (key, decision) => onChange({ ...answer, decisions: { ...answer.decisions, [key]: decision } });
  return (
    <div className="space-y-3">
      {found.suggestions.length === 0 ? <Nothing found={found} /> : found.suggestions.map(s => (
        <Suggestion key={s.key} suggestion={s} decision={answer.decisions[s.key]} onDecide={d => decide(s.key, d)} />
      ))}
      {found.declinedBefore > 0 && (
        <p className={MUTED}>
          {found.declinedBefore === 1 ? '1 suggestion was' : `${found.declinedBefore} suggestions were`} declined in the last review and {found.declinedBefore === 1 ? 'is' : 'are'} not asked again.
        </p>
      )}
      {verdict !== 'good' && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100">
            {asks ? 'What is your question?' : 'Anything to add about what you propose? (optional)'}
          </span>
          <textarea value={answer.remark} onChange={e => onChange({ ...answer, remark: e.target.value })} rows={3} maxLength={4000}
            className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
        </label>
      )}
    </div>
  );
}
