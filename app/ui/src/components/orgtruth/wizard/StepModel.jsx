// Import wizard step 4 for a collection — Model: the recipe step 3 proposed
// (POST /api/org-truth/propose/recipe { fileName, columns, rowCount?, template? } → { recipe, linkRules, origin, notes, timing }),
// where the proposal came from, and the editor (ModelEditor). Step 3 (StepKind)
// runs the first proposal; "Propose again" re-runs it, as a forced collection
// when the analyst picked that kind himself.
// A 501/404 from the proposal keeps the editor usable with a notice. In a
// repeat the recipe comes from the profile, and columns the new list no longer
// has are flagged. GET /propose/status tells whether a model is behind the
// proposal; when it is not configured or not available the step says the
// proposal comes from the column names only (a failing status call shows nothing).
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { WizardNav } from '@ui/components/crawler/wizardFields';
import { applyProposal, columnNamesOnly, proposeBody, recipeProblems, staleColumns, stepReady } from './wizardDraft';
import { API, NOT_AVAILABLE, sendJson } from './wizardApi';
import { Notice, SMALL_BTN_CLS } from './wizardUi';
import ModelEditor from './ModelEditor';

const ORIGIN_TEXT = {
  model: 'Proposed by the model. Check it before you continue.',
  heuristic: 'Proposed from the column names and values. Check it before you continue.',
  data: 'Proposed from the data: every column\'s values were compared with the accounts, groups and other organisation lists. Check it before you continue.',
};

export default function StepModel({ draft, update, onBack, onNext }) {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const { data: status } = useFetch(`${API}/propose/status`, { authFetch });
  const stale = staleColumns(draft);
  const problems = recipeProblems(draft);

  const forced = draft.templateChosen ? 'collection' : null;
  const request = async () => {
    try {
      const proposal = await sendJson(authFetch, '/propose/recipe', proposeBody(draft, forced));
      update(d => applyProposal(d, proposal, forced));
    } catch (e) {
      const unavailable = e.notAvailable || /^HTTP 404/.test(e.message);
      setNotice(unavailable ? `${NOT_AVAILABLE} Describe the entities yourself below.` : `The proposal failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const propose = () => {
    setNotice(null);
    setBusy(true);
    request();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={propose} disabled={busy || !draft.source} className={SMALL_BTN_CLS}>
          {busy ? 'Proposing…' : 'Propose again'}
        </button>
        <span className="text-sm text-gray-700 dark:text-gray-300">
          Let Identity Atlas propose which columns are entities, attributes and relations.
        </span>
      </div>

      {columnNamesOnly(status) && (
        <Notice>Proposing from column names only: the local model is not available{status.reason ? ` (${status.reason})` : ''}.</Notice>
      )}
      {notice && <Notice variant="warning">{notice}</Notice>}
      {draft.proposalOrigin && (
        <Notice>
          {ORIGIN_TEXT[draft.proposalOrigin] ?? ORIGIN_TEXT.heuristic}
          {draft.notes.length > 0 && (
            <ul className="list-disc ml-5 mt-1">{draft.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          )}
        </Notice>
      )}
      {stale.length > 0 && (
        <Notice variant="warning">The list no longer has these columns the profile uses: {stale.join(', ')}.</Notice>
      )}

      <ModelEditor draft={draft} update={update} />

      {problems.length > 0 && draft.recipe.entities.length > 0 && (
        <ul aria-label="Recipe problems" className="text-sm text-amber-800 dark:text-amber-200 list-disc ml-5">
          {problems.map(p => <li key={p}>{p}</li>)}
        </ul>
      )}

      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={!stepReady(4, draft)} />
    </div>
  );
}
