// Organisation → Import wizard (workstream T5).
//
// Six steps on WizardShell + Stepper:
//   1 Start      new import, or repeat an import profile (full / delta, adjust the config?)   StepStart
//   2 Source     upload the list (POST /api/org-truth/sources), observed date                 StepSource
//   3 Model      proposed recipe (POST /api/org-truth/propose/recipe), editable               StepModel
//   4 Links      detected candidates per entity type (POST /api/org-truth/links/detect)       StepLinks
//   5 Quality    dry run (POST /api/org-truth/runs/dry-run), threshold, verdict              StepQuality
//   6 Confirm    save the profile (POST/PUT /profiles), start the run (POST /runs), poll it   StepConfirm
//
// Props: { onClose(imported: boolean), profileId? }
//
// This file is composition only: the draft (all edits in wizardDraft.js, passed
// to the panels as `update(fn)` so an edit always applies to the latest draft),
// the current step, and the wizard-level error. Step 3 is hidden in a repeat
// unless the analyst chose to adjust the configuration. `profileId` opens the
// wizard on a repeat of that profile (GET /api/org-truth/profiles/:id).
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import WizardShell from '@ui/components/WizardShell';
import { emptyDraft, modelStepShown, nextStep, prevStep, selectProfile } from './wizardDraft';
import { getJson } from './wizardApi';
import StepStart from './StepStart';
import StepSource from './StepSource';
import StepModel from './StepModel';
import StepLinks from './StepLinks';
import StepQuality from './StepQuality';
import StepConfirm from './StepConfirm';

const STEPS = [
  { n: 1, label: 'Start' }, { n: 2, label: 'Source' }, { n: 3, label: 'Model' },
  { n: 4, label: 'Links' }, { n: 5, label: 'Quality' }, { n: 6, label: 'Confirm' },
];
const PANELS = { 1: StepStart, 2: StepSource, 3: StepModel, 4: StepLinks, 5: StepQuality, 6: StepConfirm };

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
  const steps = STEPS.map(s => (s.n === 3 ? { ...s, shown: modelStepShown(draft) } : s));
  const Panel = PANELS[step];

  return (
    <WizardShell
      title="Import organisation truth"
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
