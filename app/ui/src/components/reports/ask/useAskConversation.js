// The assistant's conversation: what was said on screen (turns), what the model
// is sent as context (history), and the two ways to move it on — asking a
// question, or picking the object a "did you mean …?" offered.

import { useRef, useState } from 'react';
import { postJson } from './AskAssistant.api';
import { useBusyRun } from '@ui/hooks/useBusyRun';

export const MAX_HISTORY = 10;

// One per chat. It ties the turns together in the conversation store, which is
// what makes a history list and "continue this conversation" possible at all.
const freshConversationId = () =>
  globalThis.crypto?.randomUUID?.() ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * A stored turn, rebuilt as the reply the screen shows.
 *
 * The store keeps the model's raw reply, so a resumed conversation shows what
 * the model actually said rather than a paraphrase — and the definition, kept
 * separately, is the one that ran. What cannot be rebuilt is left out: timings
 * (they were true once, for that machine on that day) and the choices of a
 * "did you mean" (those were the options of the moment).
 */
export function replyFromStored({ rawReply, definition, outcome, clarification }) {
  let parsed = null;
  try { parsed = rawReply ? JSON.parse(rawReply) : null; } catch { parsed = null; }
  if (parsed?.kind === 'clarify') {
    return { kind: 'clarify', question: parsed.question ?? clarification ?? '', options: Array.isArray(parsed.options) ? parsed.options : [], raw: rawReply, timing: null };
  }
  if (parsed?.kind === 'decline' || outcome === 'declined') {
    return { kind: 'decline', reason: parsed?.reason ?? clarification ?? '', raw: rawReply, timing: null };
  }
  if (definition || parsed?.kind === 'report') {
    return {
      kind: 'report', spec: definition ?? parsed?.spec ?? null,
      assumptions: Array.isArray(parsed?.assumptions) ? parsed.assumptions : [],
      raw: rawReply, timing: null, resumed: true,
    };
  }
  if (outcome === 'confirm') {
    return { kind: 'confirm', confirm: { message: clarification ?? 'A name needed confirming.', choices: [] }, spec: definition ?? null, raw: rawReply, timing: null };
  }
  const message = outcome === 'timeout' ? 'That took too long, so it was stopped.' : 'This turn could not be turned into a report.';
  return { kind: 'error', message, errors: [], timing: null };
}

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
  const { busy, error, run } = useBusyRun();
  const lastQuestion = useRef('');
  const [conversationId, setConversationId] = useState(freshConversationId);

  const addTurn = (turn) => setTurns(t => [...t, turn]);

  const ask = async (text) => {
    const question = text.trim();
    if (!question || busy) return;
    setInput('');
    await run(async () => {
      addTurn({ role: 'user', text: question });
      const reply = await postJson(authFetch, '/api/nl-reports/interpret', {
        question,
        history: [...history, ...specContext(currentSpec)].slice(-MAX_HISTORY),
        conversationId,
      });
      addTurn({ role: 'assistant', reply });
      setHistory(h => [...h, { role: 'user', content: question }, { role: 'assistant', content: reply.raw || '' }].slice(-MAX_HISTORY));
      if (reply.kind === 'report') onReport(reply, question, conversationId);
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
      onReport({ ...next, kind: 'report' }, lastQuestion.current, conversationId);
    }
  });

  // Pick a stored conversation back up: what was said, rebuilt for the screen,
  // and the model's own replies, rebuilt as the history it is sent — so the
  // next question continues the thread the model actually had. The last
  // answer is reported again so the page can show its rows; that is a query,
  // not a model call.
  const load = (id, storedTurns) => {
    if (busy) return;
    const shown = [];
    const sent = [];
    let lastReport = null;
    for (const t of storedTurns ?? []) {
      shown.push({ role: 'user', text: t.question });
      const reply = replyFromStored(t);
      shown.push({ role: 'assistant', reply });
      if (t.rawReply) sent.push({ role: 'user', content: t.question }, { role: 'assistant', content: t.rawReply });
      if (reply.kind === 'report' && reply.spec) lastReport = { reply, question: t.question };
    }
    setConversationId(id);
    setTurns(shown);
    setHistory(sent.slice(-MAX_HISTORY));
    setInput('');
    lastQuestion.current = '';
    // Under the picked-up chat's id, so a follow-up there still knows what "these" means.
    if (lastReport) onReport(lastReport.reply, lastReport.question, id);
  };

  // Start over: a new thread id, and nothing on screen or in the history the
  // model is sent. The old conversation stays in the store under its own id.
  const newConversation = () => {
    if (busy) return;
    setConversationId(freshConversationId());
    setTurns([]);
    setHistory([]);
    setInput('');
    lastQuestion.current = '';
  };

  const lastTurn = turns[turns.length - 1];
  const awaitingAnswer = lastTurn?.role === 'assistant' && lastTurn.reply.kind === 'clarify';

  return {
    input, setInput, turns, busy, error, ask, confirmChoice, awaitingAnswer,
    conversationId, newConversation, load,
  };
}
