// The assistant's conversation: what was said on screen (turns), what the model
// is sent as context (history), and the two ways to move it on — asking a
// question, or picking the object a "did you mean …?" offered.

import { useRef, useState } from 'react';
import { postJson } from './AskAssistant.api';

export const MAX_HISTORY = 10;

// The builder's current definition (possibly edited by hand) is the latest
// truth, so it is sent as the last thing "said" before the new message.
export function specContext(currentSpec) {
  if (!currentSpec) return [];
  return [
    { role: 'user', content: 'This is the current report definition.' },
    { role: 'assistant', content: JSON.stringify({ kind: 'report', assumptions: [], spec: currentSpec }) },
  ];
}

/**
 * @param {object}   args
 * @param {Function} args.authFetch
 * @param {object}   [args.currentSpec]  the definition in the builder right now
 * @param {Function} args.onReport       (reply, question) → called with a model report reply
 */
export function useAskConversation({ authFetch, currentSpec, onReport }) {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState([]);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const lastQuestion = useRef('');

  const addTurn = (turn) => setTurns(t => [...t, turn]);

  // Marks the conversation busy around one request and shows its failure.
  const run = async (work) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const ask = async (text) => {
    const question = text.trim();
    if (!question || busy) return;
    setInput('');
    await run(async () => {
      addTurn({ role: 'user', text: question });
      const reply = await postJson(authFetch, '/api/nl-reports/interpret', {
        question, history: [...history, ...specContext(currentSpec)].slice(-MAX_HISTORY),
      });
      addTurn({ role: 'assistant', reply });
      setHistory(h => [...h, { role: 'user', content: question }, { role: 'assistant', content: reply.raw || '' }].slice(-MAX_HISTORY));
      if (reply.kind === 'report') onReport(reply, question);
      if (reply.kind === 'confirm') lastQuestion.current = question;
    });
  };

  // The analyst picked (or typed) the object they meant. Applied by the server;
  // the model is not asked again.
  const confirmChoice = (reply, choice) => run(async () => {
    const resolved = await postJson(authFetch, '/api/nl-reports/resolve', { spec: reply.spec, choice });
    const next = { ...reply, spec: resolved.spec, explanation: resolved.explanation };
    addTurn({ role: 'assistant', reply: { kind: 'chosen', name: choice.name } });
    if (resolved.confirm) {
      addTurn({ role: 'assistant', reply: { ...next, kind: 'confirm', confirm: resolved.confirm, timing: null } });
    } else {
      addTurn({ role: 'assistant', reply: { ...next, kind: 'report', timing: null } });
      onReport({ ...next, kind: 'report' }, lastQuestion.current);
    }
  });

  const lastTurn = turns[turns.length - 1];
  const awaitingAnswer = lastTurn?.role === 'assistant' && lastTurn.reply.kind === 'clarify';

  return { input, setInput, turns, busy, error, ask, confirmChoice, awaitingAnswer };
}
