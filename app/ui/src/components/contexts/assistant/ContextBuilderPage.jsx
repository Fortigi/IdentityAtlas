// EXPERIMENTAL — build a context tree with the context assistant, in its own tab
// (#context-builder:<id>).
//
// id "new-…" starts an empty context; any other id is a context tree built earlier with
// the assistant, opened to change its recipe. The analyst describes the context to the
// local model (optional), keeps or drops the proposed search terms while seeing what
// each finds, includes or excludes individual objects, and saves. Saving runs the
// context-recipe plugin, which also refreshes the tree after every crawl.
//
// Design: docs/architecture/context-assistant.md.

import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanBuildContexts } from '@ui/hooks/useCanBuildContexts';
import ReportError from '@ui/components/reports/ReportError';
import DescribePanel from './DescribePanel';
import TermsPanel from './TermsPanel';
import MatchesPanel from './MatchesPanel';
import { BuilderHeader, CARD, H3, SettingsPanel } from './ContextBuilderParts';
import {
  addTerm, EMPTY_RECIPE, mergeTerms, removeTerm, saveBlocker, setObjectChoice, setTermMatch, toggleListValue, toggleTerm,
} from './recipeDraft';
import { useRecipeEvaluation } from './useRecipeEvaluation';
import { useTermConversation } from './useTermConversation';
import { useContextSave } from './useContextSave';

function blocker({ enabled, error, loading, onClose }) {
  if (!enabled) {
    return (
      <ReportError
        title="You cannot build contexts here"
        message="The context assistant is either switched off for this install (Admin → Experimental) or your role does not include Build contexts."
        onClose={onClose}
      />
    );
  }
  if (error) return <ReportError title="Cannot open the context builder" message={error.message} onClose={onClose} />;
  if (loading) return <div className="flex h-64 items-center justify-center text-gray-500 dark:text-gray-400">Loading…</div>;
  return null;
}

export default function ContextBuilderPage({ builderId, onClose, onOpenDetail, onCacheData }) {
  const { authFetch } = useAuth();
  const enabled = useCanBuildContexts();
  const isNew = builderId.startsWith('new-');

  const { data: options, error: optionsError } = useFetch(enabled ? '/api/context-assistant/options' : null, { authFetch });
  const { data: saved, error: savedError, loading: savedLoading } = useFetch(
    enabled && !isNew ? `/api/context-assistant/recipe/${encodeURIComponent(builderId)}` : null, { authFetch });

  const [recipe, setRecipe] = useState(EMPTY_RECIPE);
  const [seeded, setSeeded] = useState(null);
  // Seed the draft once from the saved tree (render-time, not in an effect).
  if (saved && saved !== seeded) {
    setSeeded(saved);
    setRecipe(saved.recipe);
  }

  const update = (fn) => (...args) => setRecipe(r => fn(r, ...args));
  const conversation = useTermConversation({
    authFetch,
    recipe,
    initialQuestion: saved?.question || '',
    onTerms: (reply) => setRecipe(r => ({ ...mergeTerms(r, reply.terms), name: r.name || reply.name })),
  });
  const { evaluation, evaluating, error: evaluateError } = useRecipeEvaluation(authFetch, recipe);
  const saving = useContextSave({
    authFetch,
    initialContextId: isNew ? null : builderId,
    onSaved: (id, name) => onCacheData?.(builderId, 'context-builder', { displayName: name }),
  });

  const stop = blocker({ enabled, error: optionsError || savedError, loading: !options || (!isNew && savedLoading && !saved), onClose });
  if (stop) return stop;

  const fieldLabels = Object.fromEntries(options.fields.map(f => [f.name, f.label]));
  const memberCount = evaluation?.memberCount ?? 0;

  return (
    <section className="mx-auto max-w-6xl space-y-4" aria-labelledby="ctx-builder-heading">
      <BuilderHeader
        contextId={saving.contextId} memberCount={memberCount} evaluating={evaluating}
        blocker={saveBlocker(recipe, memberCount)} saving={saving.saving} message={saving.message}
        onSave={() => saving.save(recipe, conversation.question)}
        onOpenContext={() => onOpenDetail?.('context', saving.contextId, recipe.name)}
      />

      <div className={CARD}>
        <h3 className={H3}>Describe it <span className="font-normal text-gray-600 dark:text-gray-400">— optional, the local model proposes search terms</span></h3>
        <DescribePanel conversation={conversation} hasTerms={recipe.terms.length > 0} />
      </div>

      <div className={CARD}>
        <h3 className={H3}>Search terms</h3>
        <TermsPanel
          recipe={recipe} stats={evaluation?.terms} evaluation={evaluation} fieldLabels={fieldLabels} memberCount={memberCount}
          actions={{
            toggle: update(toggleTerm), match: update(setTermMatch), remove: update(removeTerm),
            add: update(addTerm), addRelated: update((r, word) => addTerm(r, word, 'related')),
          }}
        />
      </div>

      <SettingsPanel
        recipe={recipe} options={options} fieldLabels={fieldLabels}
        onName={name => setRecipe(r => ({ ...r, name }))}
        onStructure={structure => setRecipe(r => ({ ...r, structure }))}
        onToggleType={update((r, v) => toggleListValue(r, 'resourceTypes', v))}
        onToggleField={update((r, v) => toggleListValue(r, 'fields', v))}
      />

      <div className={CARD}>
        <h3 className={H3}>What the terms find</h3>
        {evaluateError && <p className="mb-2 text-sm text-red-700 dark:text-red-300" role="alert">{evaluateError}</p>}
        <MatchesPanel evaluation={evaluation} recipe={recipe} fieldLabels={fieldLabels}
          onChoose={update(setObjectChoice)} onOpenDetail={onOpenDetail} />
      </div>
    </section>
  );
}
