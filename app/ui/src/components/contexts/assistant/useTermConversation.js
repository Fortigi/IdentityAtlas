// The "describe it" conversation of the context builder: the analyst describes the
// context, the local model answers with search terms or one clarifying question, and
// "suggest more" asks for new terms given the ones kept and dropped so far.

import { useState } from 'react';
import { postJson } from '@ui/components/reports/ask/AskAssistant.api';
import { useBusyRun } from '@ui/hooks/useBusyRun';

export const MAX_HISTORY = 8;

/**
 * @param {object}   args
 * @param {Function} args.authFetch
 * @param {object}   args.recipe        the draft, sent with "suggest more"
 * @param {Function} args.onTerms       (reply) → the model proposed terms
 * @param {string}   [args.initialQuestion]  the description a saved context was built from
 */
export function useTermConversation({ authFetch, recipe, onTerms, initialQuestion = '' }) {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState([]);
  const [history, setHistory] = useState([]);
  const [asked, setQuestion] = useState('');
  // A saved context's description arrives after the first render, so it is read live.
  const question = asked || initialQuestion;
  const { busy, error, run } = useBusyRun();

  const addTurn = (turn) => setTurns(t => [...t, turn]);

  const ask = (text) => {
    const said = String(text ?? '').trim();
    if (!said || busy) return undefined;
    setInput('');
    return run(async () => {
      addTurn({ role: 'user', text: said });
      const reply = await postJson(authFetch, '/api/context-assistant/interpret', { question: said, history });
      addTurn({ role: 'assistant', reply });
      setHistory(h => [...h, { role: 'user', content: said }, { role: 'assistant', content: reply.raw || '' }].slice(-MAX_HISTORY));
      // The first description is what "suggest more" keeps referring to; an answer to a
      // clarifying question refines it.
      setQuestion(q => { const base = q || initialQuestion; return base ? `${base} — ${said}` : said; });
      if (reply.kind === 'terms') onTerms(reply);
    });
  };

  const suggestMore = () => {
    if (!question || busy) return undefined;
    return run(async () => {
      addTurn({ role: 'user', text: 'Suggest more terms' });
      const reply = await postJson(authFetch, '/api/context-assistant/suggest', { question, recipe });
      addTurn({ role: 'assistant', reply });
      if (reply.kind === 'terms') onTerms(reply);
    });
  };

  const lastTurn = turns[turns.length - 1];
  const awaitingAnswer = lastTurn?.role === 'assistant' && lastTurn.reply.kind === 'clarify';

  return { input, setInput, turns, busy, error, question, ask, suggestMore, awaitingAnswer };
}
