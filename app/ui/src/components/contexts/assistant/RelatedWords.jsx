// Context builder — "related words": words that are typical of the names of the objects
// already in the context. Found in the data, not by the model, so it finds a customer's
// own names ("VSTS", an application's abbreviation) that no model can know.

import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { postJson } from '@ui/components/reports/ask/AskAssistant.api';
import { MUTED, SECONDARY } from '@ui/components/reports/ask/AskAssistant.styles';
import { relatedWordText } from './recipeDraft';

/**
 * @param {object}   props
 * @param {object}   props.recipe
 * @param {boolean}  props.disabled  nothing in the context yet
 * @param {Function} props.onAdd     (word) → add as a term
 */
export default function RelatedWords({ recipe, disabled, onAdd }) {
  const { authFetch } = useAuth();
  const [words, setWords] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const find = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = await postJson(authFetch, '/api/context-assistant/related', { recipe });
      setWords(body.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const add = (word) => {
    onAdd(word);
    setWords(ws => ws.filter(w => w.word !== word));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY} disabled={disabled || busy} onClick={find}>
          {busy ? 'Looking…' : 'Find related words'}
        </button>
        <span className={MUTED}>Words that are typical of the names already in the context — from your data, not the model.</span>
      </div>
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {words && words.length === 0 && <p className={MUTED}>No related words stand out.</p>}
      {words && words.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {words.map(w => (
            <button key={w.word} type="button" onClick={() => add(w.word)} title={`Add "${w.word}" as a term`}
              className="rounded-full border border-gray-300 px-2.5 py-0.5 text-xs text-gray-800 hover:border-blue-400 dark:border-gray-600 dark:text-gray-200">
              + {w.word} <span className="text-gray-500 dark:text-gray-400">{relatedWordText(w)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
