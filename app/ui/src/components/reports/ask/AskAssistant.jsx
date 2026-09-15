// PROTOTYPE — "describe it" assistant inside the report builder.
//
// The analyst types what they want; the local model (chosen by an admin under
// Admin → LLM) answers with a report definition or one clarifying question.
// Follow-up messages refine the definition currently in the builder — including
// manual edits, which are sent along as the latest version.
//
// The builder works without this: when the model server is unavailable the
// assistant says so and the definition editor is the way to build a report.

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import ConfirmChoices from './ConfirmChoices';

const EXAMPLES = [
  'Guest accounts that don\'t have a manager, or whose manager is disabled',
  'Groups that have HAMIS in the name',
  'Disabled users that are still member of a group that contains LIC',
];
const BEST_GUESS = 'Use your best judgement and produce the report.';
const MAX_HISTORY = 10;

const PRIMARY = 'rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600';
const SECONDARY = 'rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-800 hover:border-blue-400 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
const MUTED = 'text-xs text-gray-600 dark:text-gray-400';

export async function postJson(authFetch, url, body, method = 'POST') {
  const res = await authFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.errors?.length ? `: ${json.errors.join('; ')}` : '';
    const err = new Error(`${json.error || `Request failed (${res.status})`}${detail}`);
    err.body = json; // callers can react to structured answers, e.g. a confirmation
    throw err;
  }
  return json;
}

function useElapsed(active) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 500);
    return () => { clearInterval(id); setSeconds(0); };
  }, [active]);
  return seconds;
}

function formatTiming(t) {
  if (!t) return '';
  const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
  return `${s(t.totalMs)} · read ${t.promptTokens} tokens in ${s(t.promptMs)} · wrote ${t.outputTokens} tokens in ${s(t.outputMs)}`;
}

function Turn({ turn, onAnswer, onConfirm, busy, isLast }) {
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
      {r.kind === 'clarify' && (
        <>
          <p>{r.question}</p>
          {isLast && (
            <div className="flex flex-wrap gap-2">
              {r.options.map(o => <button key={o} type="button" disabled={busy} className={SECONDARY} onClick={() => onAnswer(o)}>{o}</button>)}
              <button type="button" disabled={busy} className={SECONDARY} onClick={() => onAnswer(BEST_GUESS)}>Use your best guess</button>
            </div>
          )}
        </>
      )}
      {r.kind === 'confirm' && (isLast
        ? <ConfirmChoices confirm={r.confirm} busy={busy} onChoose={choice => onConfirm(r, choice)} />
        : <p>{r.confirm.message}</p>)}
      {r.kind === 'chosen' && <p>Using “{r.name}”.</p>}
      {r.kind === 'report' && (
        <>
          <p>I've updated the report definition{r.repaired ? ' (after correcting my first attempt)' : ''} — check it below.</p>
          {r.assumptions?.length > 0 && (
            <ul className="list-disc pl-5 text-gray-700 dark:text-gray-300">
              {r.assumptions.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          )}
        </>
      )}
      {r.kind === 'error' && <p className="text-red-700 dark:text-red-300">{r.message}{r.errors?.length ? ` (${r.errors.join('; ')})` : ''}</p>}
      <p className={MUTED}>{formatTiming(r.timing)}</p>
    </div>
  );
}

/**
 * @param {object}   props
 * @param {object}   [props.currentSpec]  the definition in the builder right now
 * @param {Function} props.onReport       (reply, question) → called with a model report reply
 */
export default function AskAssistant({ currentSpec, onReport }) {
  const { authFetch } = useAuth();
  const { data: status, loading: statusLoading } = useFetch('/api/nl-reports/status', { authFetch });
  const [warm, setWarm] = useState('idle');
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState([]);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const elapsed = useElapsed(busy || warm === 'warming');
  const warmed = useRef(false);
  const lastQuestion = useRef('');

  // Load the model and pre-read the prompt when the builder opens, so the first
  // question doesn't pay for it.
  useEffect(() => {
    if (!status?.available || warmed.current) return;
    warmed.current = true;
    setWarm(status.loaded ? 'ready' : 'warming');
    postJson(authFetch, '/api/nl-reports/warm', {})
      .then(() => setWarm('ready'))
      .catch(() => setWarm('error'));
  }, [status, authFetch]);

  if (statusLoading) return null;
  if (!status?.available) {
    return (
      <p className="text-sm text-gray-600 dark:text-gray-400">
        The report generator is not available ({status?.reason === 'model-not-installed' ? `model "${status.model}" is not installed` : 'the local model server is not reachable'}).
        You can still build the report with the definition editor below. An administrator can choose the model under Admin → LLM.
      </p>
    );
  }

  const ask = async (text) => {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    setInput('');
    setTurns(t => [...t, { role: 'user', text: question }]);
    // The builder's current definition (possibly edited by hand) is the latest
    // truth, so it is sent as the last thing "said" before the new message.
    const context = currentSpec
      ? [{ role: 'user', content: 'This is the current report definition.' },
        { role: 'assistant', content: JSON.stringify({ kind: 'report', assumptions: [], spec: currentSpec }) }]
      : [];
    try {
      const reply = await postJson(authFetch, '/api/nl-reports/interpret', { question, history: [...history, ...context].slice(-MAX_HISTORY) });
      setTurns(t => [...t, { role: 'assistant', reply }]);
      setHistory(h => [...h, { role: 'user', content: question }, { role: 'assistant', content: reply.raw || '' }].slice(-MAX_HISTORY));
      if (reply.kind === 'report') onReport(reply, question);
      if (reply.kind === 'confirm') lastQuestion.current = question;
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // The analyst picked (or typed) the object they meant. Applied by the server;
  // the model is not asked again.
  const confirmChoice = async (reply, choice) => {
    setBusy(true);
    setError(null);
    try {
      const resolved = await postJson(authFetch, '/api/nl-reports/resolve', { spec: reply.spec, choice });
      const next = { ...reply, spec: resolved.spec, explanation: resolved.explanation };
      setTurns(t => [...t, { role: 'assistant', reply: { kind: 'chosen', name: choice.name } }]);
      if (resolved.confirm) {
        setTurns(t => [...t, { role: 'assistant', reply: { ...next, kind: 'confirm', confirm: resolved.confirm, timing: null } }]);
      } else {
        setTurns(t => [...t, { role: 'assistant', reply: { ...next, kind: 'report', timing: null } }]);
        onReport({ ...next, kind: 'report' }, lastQuestion.current);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const lastTurn = turns[turns.length - 1];
  const awaitingAnswer = lastTurn?.role === 'assistant' && lastTurn.reply.kind === 'clarify';

  return (
    <div className="space-y-3">
      {turns.length > 0 && (
        <div className="space-y-3">
          {turns.map((t, i) => <Turn key={i} turn={t} busy={busy} isLast={i === turns.length - 1} onAnswer={ask} onConfirm={confirmChoice} />)}
        </div>
      )}
      {busy && <p className={MUTED} aria-live="polite">Thinking… {elapsed}s{warm === 'warming' ? ' (the model is still warming up)' : ''}</p>}
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}

      <form className="space-y-2" onSubmit={e => { e.preventDefault(); ask(input); }}>
        <label htmlFor="nl-question" className="sr-only">
          {awaitingAnswer ? 'Your answer' : currentSpec ? 'Describe a change to the report' : 'Describe the report you want'}
        </label>
        <textarea id="nl-question" rows={2} value={input} disabled={busy}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
          placeholder={awaitingAnswer ? 'Or type your own answer…' : currentSpec ? 'Describe a change, e.g. "only enabled accounts, and show the department"…' : 'e.g. all guest accounts without a manager'}
          className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-500" />
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className={PRIMARY} disabled={busy || !input.trim()}>{currentSpec ? 'Update' : 'Generate'}</button>
          <span className={MUTED} aria-live="polite">
            {warm === 'warming' && `model warming up… ${elapsed}s`}
            {warm === 'error' && 'model server did not respond'}
          </span>
          {!currentSpec && turns.length === 0 && EXAMPLES.map(ex => (
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
