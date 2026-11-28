import { ownersOf, ownerChanges, stepLabel, verdictLabel } from './reviewSteps';
import { DECISION_INFO, IMPROVEMENTS, suggestionText } from './improvementSteps';

// ─── What a review said, step by step ────────────────────────────────────
// One line per judged step: the verdict, the reviewer's change or question, and
// for the ownership step the people they proposed, read against the owners in
// the review's own snapshot. Used for a saved review and for the wizard's last
// screen before signing. The improvements step lists role mining's suggestions
// with the reviewer's decision on each, or that there were none.

const BADGE = {
  good: 'border-green-200 bg-green-100 text-green-800 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300',
  needsChange: 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200',
  notUnderstood: 'border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-200',
};

export function VerdictBadge({ verdict }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${BADGE[verdict] ?? ''}`}>
      {verdictLabel(verdict)}
    </span>
  );
}

function Suggestions({ proposal }) {
  const list = proposal?.suggestions ?? [];
  if (list.length === 0) return <p className="text-gray-600 dark:text-gray-400">Role mining found no improvements.</p>;
  return (
    <ul className="list-disc pl-5">
      {list.map(s => (
        <li key={s.key}>
          {suggestionText(s).title} ({s.confidence}% sure): <span className="font-medium">{DECISION_INFO[s.decision]?.short ?? 'not decided'}</span>
        </li>
      ))}
    </ul>
  );
}

export default function ReviewRecord({ steps = [], snapshot }) {
  if (steps.length === 0) return <p className="text-sm text-gray-600 dark:text-gray-400">No steps were judged.</p>;
  const owners = ownersOf(snapshot);
  return (
    <ul className="space-y-2" data-testid="review-record">
      {steps.map((s) => {
        // A proposal counts only where the verdict asks for a change.
        const changes = s.step === 'ownership' && s.verdict === 'needsChange' ? ownerChanges(owners, s.proposal) : [];
        const remark = s.verdict === 'good' ? '' : (s.remark || '').trim();
        return (
          <li key={s.step} className="grid grid-cols-1 gap-1 sm:grid-cols-[11rem_1fr]" data-testid={`record-${s.step}`}>
            <div className="flex items-start justify-between gap-2 sm:block sm:space-y-1">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{stepLabel(s.step)}</div>
              <VerdictBadge verdict={s.verdict} />
            </div>
            <div className="text-sm text-gray-800 dark:text-gray-200">
              {s.step === IMPROVEMENTS && <Suggestions proposal={s.proposal} />}
              {changes.length > 0 && <ul className="list-disc pl-5">{changes.map(c => <li key={c}>{c}</li>)}</ul>}
              {remark && <p className="whitespace-pre-wrap">{remark}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
