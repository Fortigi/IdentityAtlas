// Organisation → Import wizard (workstream T5, templates T10).
//
// Seven steps on WizardShell + Stepper:
//   1 Start      new import, or repeat an import profile (full / delta, adjust the config?)   StepStart
//   2 Source     upload the list (POST /api/org-truth/sources), observed date                 StepSource
//   3 Kind       what kind of list: collection / enrichment / activity / relation;
//                proposes the recipe (POST /api/org-truth/propose/recipe [, { template }])    StepKind
//   4 Model      the kind's mapping: collection StepModel (+ ModelEditor), enrichment
//                StepEnrichment, activity StepActivity, relation StepRelation
//   5 Links      detected candidates per entity type (POST /api/org-truth/links/detect);
//                collection and enrichment only                                              StepLinks
//   6 Quality    dry run (POST /api/org-truth/runs/dry-run), threshold, verdict              StepQuality
//   7 Confirm    save the profile (POST/PUT /profiles), start the run (POST /runs), poll it   StepConfirm
//
// Props: { onClose(imported: boolean), profileId? }
//
// This file is composition only: the draft (all edits in wizardDraft.js, passed
// to the panels as `update(fn)` so an edit always applies to the latest draft),
// the current step, and the wizard-level error. Which steps show is
// wizardDraft.stepShown (3 and 4 are hidden in a repeat unless the analyst
// chose to adjust the configuration; 5 only for kinds with link rules).
// `profileId` opens the wizard on a repeat of that profile
// (GET /api/org-truth/profiles/:id).
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import WizardShell from '@ui/components/WizardShell';
import { emptyDraft, nextStep, prevStep, selectProfile, stepShown } from './wizardDraft';
import { templateOf } from './templateDraft';
import { getJson } from './wizardApi';
import StepStart from './StepStart';
import StepSource from './StepSource';
import StepKind from './StepKind';
import StepModel from './StepModel';
import StepEnrichment from './StepEnrichment';
import StepActivity from './StepActivity';
import StepRelation from './StepRelation';
import StepLinks from './StepLinks';
import StepQuality from './StepQuality';
import StepConfirm from './StepConfirm';

const STEPS = [
  { n: 1, label: 'Start' }, { n: 2, label: 'Source' }, { n: 3, label: 'Kind' }, { n: 4, label: 'Model' },
  { n: 5, label: 'Links' }, { n: 6, label: 'Quality' }, { n: 7, label: 'Confirm' },
];
const PANELS = { 1: StepStart, 2: StepSource, 3: StepKind, 5: StepLinks, 6: StepQuality, 7: StepConfirm };
const MAPPING = { collection: StepModel, enrichment: StepEnrichment, activity: StepActivity, relation: StepRelation };

const initialDraft = (profileId) => (profileId ? { ...emptyDraft(), mode: 'repeat' } : emptyDraft());

export default function ImportWizard({ onClose, profileId }) {
  const { authFetch } = useAuth();
  const [draft, setDraft] = useState(() => initialDraft(profileId));
  const [step, setStep] = useState(1);
  const [error, setError] = useState(null);
  const update = useCallback((fn) => setDraft(d => fn(d)), []);

  useEffect(() => {
    if (!profileId) return undefined;
    let cancelled = false;
    getJson(authFetch, `/profiles/${encodeURIComponent(profileId)}`)
      .then(p => { if (!cancelled) update(d => (d.profile ? d : selectProfile(d, p))); })
      .catch(e => { if (!cancelled) setError(`Could not load the import profile: ${e.message}`); });
    return () => { cancelled = true; };
  }, [authFetch, profileId, update]);

  const goto = (n) => { setError(null); setStep(n); };
  const steps = STEPS.map(s => ({ ...s, shown: stepShown(s.n, draft) }));
  const Panel = step === 4 ? MAPPING[templateOf(draft.recipe)] : PANELS[step];

  return (
    <WizardShell
      title="Import additional information"
      onCancel={() => onClose(false)}
      steps={steps}
      currentStep={step}
      onStepClick={(n) => { if (n < step) goto(n); }}
      error={error}
    >
      <Panel
        draft={draft}
        update={update}
        onBack={() => goto(prevStep(step, draft))}
        onNext={() => goto(nextStep(step, draft))}
        onGoto={goto}
        onError={setError}
        onClose={onClose}
      />
    </WizardShell>
  );
}
