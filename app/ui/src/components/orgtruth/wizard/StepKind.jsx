// Import wizard step 3 — What kind of list is this? Four cards (collection,
// enrichment, activity, relation; templateDraft.TEMPLATE_CARDS). On a fresh
// source the step asks the API to propose the recipe by itself
// (POST /api/org-truth/propose/recipe → { recipe, linkRules, origin, notes,
// template: { kind, confidence, reason, alternatives } }); the proposed kind is
// preselected and its card shows the reason. Picking another card re-proposes
// with { template: kind } and the answer becomes that kind's recipe; when that
// call fails the kind stays chosen with an empty recipe the next step fills by
// hand. A repeat shows the profile's kind and proposes nothing unasked.
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { WizardNav } from '@ui/components/crawler/wizardFields';
import { applyProposal, chooseTemplate, proposeBody, shouldAutoPropose, stepReady } from './wizardDraft';
import { TEMPLATE_CARDS, TEMPLATE_KINDS, templateOf } from './templateDraft';
import { NOT_AVAILABLE, sendJson } from './wizardApi';
import { Chip, Notice } from './wizardUi';

const CARD_BASE = 'flex items-start gap-3 p-3 border rounded-lg cursor-pointer';
const CARD_ON = 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/20';
const CARD_OFF = 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800';

function KindCard({ kind, selected, proposal, disabled, onPick }) {
  const card = TEMPLATE_CARDS[kind];
  const proposed = proposal?.kind === kind;
  return (
    <label className={`${CARD_BASE} ${selected ? CARD_ON : CARD_OFF}`}>
      <input type="radio" name="templateKind" value={kind} checked={selected} disabled={disabled} onChange={() => onPick(kind)} className="mt-1" />
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{card.label}</span>
          {proposed && <Chip>Proposed{proposal.confidence != null ? ` · ${Math.round(proposal.confidence)} %` : ''}</Chip>}
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-400">{card.description}</p>
        {proposed && proposal.reason && <p className="text-xs text-gray-800 dark:text-gray-200">{proposal.reason}</p>}
      </div>
    </label>
  );
}

const failureText = (e) => {
  const unavailable = e.notAvailable || /^HTTP 404/.test(e.message);
  return unavailable ? `${NOT_AVAILABLE} Pick the kind yourself and describe the list in the next step.` : `The proposal failed: ${e.message}`;
};

export default function StepKind({ draft, update, onBack, onNext }) {
  const { authFetch } = useAuth();
  // Busy from the first render when the step proposes on its own, so the
  // effect below only starts the request (all state updates follow its await).
  const [busy, setBusy] = useState(() => shouldAutoPropose(draft));
  const [notice, setNotice] = useState(null);
  const autoRan = useRef(false);
  const selected = templateOf(draft.recipe);

  const request = async (kind) => {
    try {
      const proposal = await sendJson(authFetch, '/propose/recipe', proposeBody(draft, kind));
      // a later pick wins over an answer that arrives for an earlier one
      update(d => (kind && templateOf(d.recipe) !== kind ? d : applyProposal(d, proposal, kind ?? null)));
    } catch (e) {
      setNotice(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = (kind) => {
    if (kind === selected) return;
    setNotice(null);
    setBusy(true);
    update(d => chooseTemplate(d, kind));
    request(kind);
  };

  // One automatic proposal per visit to the step, and only on an empty draft.
  useEffect(() => {
    if (autoRan.current || !shouldAutoPropose(draft)) return;
    autoRan.current = true;
    request();
  });

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">What kind of list is this?</legend>
        {TEMPLATE_KINDS.map(k => (
          <KindCard key={k} kind={k} selected={k === selected} proposal={draft.templateProposal} disabled={busy} onPick={pick} />
        ))}
      </fieldset>
      {busy && <p className="text-sm text-gray-700 dark:text-gray-300" aria-live="polite">Proposing…</p>}
      {notice && <Notice variant="warning">{notice}</Notice>}
      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={busy || !stepReady(3, draft)} />
    </div>
  );
}
