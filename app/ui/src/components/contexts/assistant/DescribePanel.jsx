// Context builder — "describe it": ask the local model for search terms.
//
// Optional: when the report generator is not deployed or not reachable the panel says
// so, and the analyst types the terms in the terms panel instead.

import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { MUTED, PRIMARY, SECONDARY } from '@ui/components/reports/ask/AskAssistant.styles';
import { formatTiming, unavailableReason, warmStatusText } from '@ui/components/reports/ask/AskAssistant.text';
import { isWarmLoading, useElapsed, useModelWarmup } from '@ui/components/reports/ask/useAskWarmup';
import TurnBubble from '@ui/components/assistant/TurnBubble';
import { termsReplyText } from './recipeDraft';

const EXAMPLES = [
  'Alle groepen rond het inkoopproces',
  'Everything to do with our DevOps projects',
  'Groups for licences',
];

function TermsReply({ reply }) {
  return (
    <>
      <p>{termsReplyText(reply.terms)}</p>
      {reply.notes?.length > 0 && (
        <ul className="list-disc pl-5 text-gray-700 dark:text-gray-300">
          {reply.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </>
  );
}

function Turn({ turn, isLast, busy, onAnswer }) {
  if (turn.role === 'user') return <TurnBubble role="user" text={turn.text} />;
  const r = turn.reply;
  return (
    <TurnBubble role="assistant">
      {r.kind === 'terms' && <TermsReply reply={r} />}
      {r.kind === 'clarify' && (
        <>
          <p>{r.question}</p>
          {isLast && (
            <div className="flex flex-wrap gap-2">
              {r.options.map(o => <button key={o} type="button" disabled={busy} className={SECONDARY} onClick={() => onAnswer(o)}>{o}</button>)}
            </div>
          )}
        </>
      )}
      {r.kind === 'error' && <p className="text-red-700 dark:text-red-300">{r.message}</p>}
      <p className={MUTED}>{formatTiming(r.timing)}</p>
    </TurnBubble>
  );
}

/**
 * @param {object} props
 * @param {object} props.conversation  useTermConversation()
 * @param {boolean} props.hasTerms     the draft already has terms (enables "suggest more")
 */
export default function DescribePanel({ conversation, hasTerms }) {
  const { authFetch } = useAuth();
  const { data: status, loading: statusLoading } = useFetch('/api/context-assistant/status', { authFetch });
  const warm = useModelWarmup(status, authFetch, '/api/context-assistant/warm');
  const { input, setInput, turns, busy, error, ask, suggestMore, question, awaitingAnswer } = conversation;
  const loading = isWarmLoading(warm);
  const elapsed = useElapsed(busy || loading);

  if (statusLoading) return null;
  if (!status?.available) {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-400">
        The local model is not available ({unavailableReason(status)}). You can still type the search terms yourself below.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {turns.map((t, i) => <Turn key={i} turn={t} busy={busy} isLast={i === turns.length - 1} onAnswer={ask} />)}
      {busy && <p className={MUTED} aria-live="polite">Thinking… {elapsed}s{loading ? ' (the model is still loading)' : ''}</p>}
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}

      <form className="space-y-2" onSubmit={e => { e.preventDefault(); ask(input); }}>
        <label htmlFor="ctx-question" className="sr-only">{awaitingAnswer ? 'Your answer' : 'Describe the context'}</label>
        <textarea id="ctx-question" rows={2} value={input} disabled={busy}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
          placeholder={awaitingAnswer ? 'Or type your own answer…' : 'e.g. all groups around the purchasing process, or everything to do with HAMIS'}
          className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-500" />
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className={PRIMARY} disabled={busy || !input.trim()}>Propose terms</button>
          {hasTerms && question && (
            <button type="button" className={SECONDARY} disabled={busy} onClick={suggestMore}>Suggest more terms</button>
          )}
          <span className={MUTED} aria-live="polite">{warmStatusText(warm, elapsed)}</span>
          {!hasTerms && turns.length === 0 && EXAMPLES.map(ex => (
            <button key={ex} type="button" disabled={busy} onClick={() => ask(ex)}
              className="rounded-full border border-gray-300 px-2.5 py-0.5 text-xs text-gray-700 hover:border-blue-400 dark:border-gray-600 dark:text-gray-300">
              {ex}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
