// One turn of the assistant conversation: the analyst's message, or the model's
// reply (a clarifying question, a "did you mean …?", a report, or an error).

import ConfirmChoices from './ConfirmChoices';
import { MUTED, SECONDARY } from './AskAssistant.styles';
import { formatTiming } from './AskAssistant.text';

const BEST_GUESS = 'Use your best judgement and produce the report.';

function ClarifyReply({ reply, onAnswer, busy, isLast }) {
  return (
    <>
      <p>{reply.question}</p>
      {isLast && (
        <div className="flex flex-wrap gap-2">
          {reply.options.map(o => <button key={o} type="button" disabled={busy} className={SECONDARY} onClick={() => onAnswer(o)}>{o}</button>)}
          <button type="button" disabled={busy} className={SECONDARY} onClick={() => onAnswer(BEST_GUESS)}>Use your best guess</button>
        </div>
      )}
    </>
  );
}

function ReportReply({ reply }) {
  return (
    <>
      <p>I've updated the report definition{reply.repaired ? ' (after correcting my first attempt)' : ''} — check it below.</p>
      {reply.assumptions?.length > 0 && (
        <ul className="list-disc pl-5 text-gray-700 dark:text-gray-300">
          {reply.assumptions.map((a, i) => <li key={i}>{a}</li>)}
        </ul>
      )}
    </>
  );
}

export default function Turn({ turn, onAnswer, onConfirm, busy, isLast }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-3xl rounded-lg bg-blue-50 px-3 py-2 text-sm text-gray-900 dark:bg-blue-900/30 dark:text-gray-100">{turn.text}</p>
      </div>
    );
  }
  const r = turn.reply;
  return (
    <div className="max-w-3xl space-y-2 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700/50 dark:text-gray-100">
      {r.kind === 'clarify' && <ClarifyReply reply={r} onAnswer={onAnswer} busy={busy} isLast={isLast} />}
      {r.kind === 'confirm' && (isLast
        ? <ConfirmChoices confirm={r.confirm} busy={busy} onChoose={choice => onConfirm(r, choice)} />
        : <p>{r.confirm.message}</p>)}
      {r.kind === 'chosen' && <p>Using “{r.name}”.</p>}
      {r.kind === 'report' && <ReportReply reply={r} />}
      {r.kind === 'error' && <p className="text-red-700 dark:text-red-300">{r.message}{r.errors?.length ? ` (${r.errors.join('; ')})` : ''}</p>}
      <p className={MUTED}>{formatTiming(r.timing)}</p>
    </div>
  );
}
