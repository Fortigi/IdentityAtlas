// Evaluates the draft recipe on the server — per-term numbers and the matched objects —
// a moment after the analyst stops changing it. No model involved: this is plain SQL,
// so it is fast enough to follow every tick of a term.

import { useEffect, useState } from 'react';
import { postJson } from '@ui/components/reports/ask/AskAssistant.api';

export const EVALUATE_DELAY_MS = 350;

/** A draft worth sending: something to search for, or something pinned. */
export function hasSearch(recipe) {
  return recipe.terms.length > 0 || recipe.include.length > 0;
}

/**
 * @param {Function} authFetch
 * @param {object}   recipe     the draft
 * @returns {{ evaluation: object|null, evaluating: boolean, error: string|null }}
 */
export function useRecipeEvaluation(authFetch, recipe) {
  const [state, setState] = useState({ evaluation: null, evaluating: false, error: null, for: null });
  // The whole draft except its name: renaming does not change what matches.
  const { name: _name, ...searched } = recipe;
  const request = JSON.stringify(searched);
  const searchable = hasSearch(recipe);

  useEffect(() => {
    if (!searchable) return undefined;
    let current = true;
    const timer = setTimeout(() => {
      setState(s => ({ ...s, evaluating: true }));
      postJson(authFetch, '/api/context-assistant/evaluate', { recipe: JSON.parse(request) })
        .then(evaluation => { if (current) setState({ evaluation, evaluating: false, error: null, for: request }); })
        .catch(err => { if (current) setState(s => ({ ...s, evaluating: false, error: err.message })); });
    }, EVALUATE_DELAY_MS);
    return () => { current = false; clearTimeout(timer); };
  }, [authFetch, request, searchable]);

  if (!searchable) return { evaluation: null, evaluating: false, error: null };
  return { evaluation: state.evaluation, evaluating: state.evaluating || state.for !== request, error: state.error };
}
