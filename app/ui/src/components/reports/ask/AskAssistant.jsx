// PROTOTYPE — "describe it" assistant inside the report builder.
//
// The analyst types what they want; the local model (chosen by an admin under
// Admin → LLM) answers with a report definition or one clarifying question.
// Follow-up messages refine the definition currently in the builder — including
// manual edits, which are sent along as the latest version.
//
// The builder works without this: when the model server is unavailable the
// assistant says so and the definition editor is the way to build a report.
//
// The pieces live next to this file: useAskWarmup (model loading),
// useAskConversation (turns, history, ask / confirm), AskAssistant.Turn (one
// turn) and AskAssistant.text (the status line and prompts).

import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import Turn from './AskAssistant.Turn';
import { MUTED, PRIMARY } from './AskAssistant.styles';
import { questionPrompt, unavailableReason, warmStatusText } from './AskAssistant.text';
import { useAskConversation } from './useAskConversation';
import { isWarmLoading, useElapsed, useModelWarmup } from './useAskWarmup';

// Kept exported from here: the rest of the report builder imports it from this module.
export { postJson } from './AskAssistant.api';

const EXAMPLES = [
  'Guest accounts that don\'t have a manager, or whose manager is disabled',
  'Groups that have "Finance" in the name',
  'Disabled users that are still member of a group that contains LIC',
];

function Unavailable({ status }) {
  return (
    <p className="text-sm text-gray-600 dark:text-gray-400">
      The report generator is not available ({unavailableReason(status)}).
      You can still build the report with the definition editor below. An administrator can choose the model under Admin → LLM.
    </p>
  );
}

function Examples({ busy, onAsk }) {
  return EXAMPLES.map(ex => (
    <button key={ex} type="button" disabled={busy} onClick={() => onAsk(ex)}
      className="rounded-full border border-gray-300 px-2.5 py-0.5 text-xs text-gray-700 hover:border-blue-400 dark:border-gray-600 dark:text-gray-300">
      {ex}
    </button>
  ));
}

/**
 * @param {object}   props
 * @param {object}   [props.currentSpec]  the definition in the builder right now
 * @param {Function} props.onReport       (reply, question) → called with a model report reply
 * @param {object}   [props.conversation] a useAskConversation() the page owns — the Ask tab
 *                                        does, so its history sidebar can load one into it.
 *                                        Without it the assistant keeps its own, as the
 *                                        report builder always has.
 */
export default function AskAssistant({ currentSpec, onReport, conversation }) {
  const { authFetch } = useAuth();
  const { data: status, loading: statusLoading } = useFetch('/api/nl-reports/status', { authFetch });
  const warm = useModelWarmup(status, authFetch);
  const own = useAskConversation({ authFetch, currentSpec, onReport });
  const convo = conversation ?? own;
  const { input, setInput, turns, busy, error, ask, confirmChoice } = convo;
  const loading = isWarmLoading(warm);
  const elapsed = useElapsed(busy || loading);

  if (statusLoading) return null;
  if (!status?.available) return <Unavailable status={status} />;

  const prompt = questionPrompt({ awaitingAnswer: convo.awaitingAnswer, currentSpec });

  return (
    <div className="space-y-3">
      {turns.length > 0 && (
        <div className="space-y-3">
          {turns.map((t, i) => <Turn key={i} turn={t} busy={busy} isLast={i === turns.length - 1} onAnswer={ask} onConfirm={confirmChoice} />)}
        </div>
      )}
      {busy && <p className={MUTED} aria-live="polite">Thinking… {elapsed}s{loading ? ' (the model is still loading)' : ''}</p>}
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}

      <form className="space-y-2" onSubmit={e => { e.preventDefault(); ask(input); }}>
        <label htmlFor="nl-question" className="sr-only">{prompt.label}</label>
        <textarea id="nl-question" rows={2} value={input} disabled={busy}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
          placeholder={prompt.placeholder}
          className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-500" />
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className={PRIMARY} disabled={busy || !input.trim()}>{currentSpec ? 'Update' : 'Generate'}</button>
          <span className={MUTED} aria-live="polite">{warmStatusText(warm, elapsed)}</span>
          {!currentSpec && turns.length === 0 && <Examples busy={busy} onAsk={ask} />}
        </div>
      </form>
    </div>
  );
}
