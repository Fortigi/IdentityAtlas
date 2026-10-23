import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import Stepper from '@ui/components/Stepper';
import { Modal, Field, ErrorBox, PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import { useActivityUpload } from './useActivityUpload';
import { ACTIVITY_STEPS, ACTIVITY_STEP_LIST, activityProblems, activityStepFooter } from './activity.helpers';
import ActivityMappingStep from './ActivityMappingStep';
import ActivityPreviewStep from './ActivityPreviewStep';

// Upload activity on one context: File → Mapping (the best guess, every field
// changeable, the AI's marked) → Preview → Import. Activity never changes the
// context's members; it is shown in the Activity section. `onImported(result)`
// runs after a successful import.

export default function UploadActivityWizard({ attrs, onClose, onImported }) {
  const { authFetch } = useAuth();
  const u = useActivityUpload(authFetch, attrs.id);
  const [step, setStep] = useState(ACTIVITY_STEPS.file);

  async function next() {
    if (step === ACTIVITY_STEPS.file) { if (await u.analyze()) setStep(ACTIVITY_STEPS.mapping); return; }
    if (step === ACTIVITY_STEPS.mapping) { if (await u.runPreview()) setStep(ACTIVITY_STEPS.preview); return; }
    const result = await u.apply();
    if (result) onImported(result);
  }

  const problems = u.mapping ? activityProblems(u.mapping) : [];
  const footer = activityStepFooter(step, { file: u.file, problems, preview: u.preview });

  return (
    <Modal title="Upload activity" subtitle={attrs.displayName} onClose={onClose} width={640} dismissOnBackdrop={false}>
      <div className="mb-4">
        <Stepper steps={ACTIVITY_STEP_LIST} current={step} onStepClick={(n) => n < step && setStep(n)} />
      </div>
      {step === ACTIVITY_STEPS.file && <FileStep file={u.file} onFile={u.setFile} />}
      {step === ACTIVITY_STEPS.mapping && u.mapping && <ActivityMappingStep analysis={u.analysis} mapping={u.mapping} onChange={u.setMapping} contextName={attrs.displayName} />}
      {step === ACTIVITY_STEPS.preview && <ActivityPreviewStep preview={u.preview} contextName={attrs.displayName} />}
      <ErrorBox message={u.error} />
      <div className="mt-5 flex items-center justify-between gap-2">
        <div className="text-[11px] text-gray-600 dark:text-gray-400">{step === ACTIVITY_STEPS.mapping && problems.join(' ')}</div>
        <div className="flex items-center gap-2">
          {footer.showBack && <SecondaryButton onClick={() => setStep(step - 1)} disabled={u.busy}>Back</SecondaryButton>}
          <PrimaryButton onClick={next} disabled={footer.blocked || u.busy}>{u.busy ? 'Working…' : footer.label}</PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}

function FileStep({ file, onFile }) {
  return (
    <div className="space-y-3">
      <Field label="Activity export" help="A .csv or an Excel .xlsx with a header row, one row per piece of activity: a Clockify detailed time report, an audit log. Activity is evidence of who works on what — it never changes who is a member.">
        <input type="file" accept=".csv,.txt,.xlsx" aria-label="Activity file" onChange={e => onFile(e.target.files?.[0] || null)}
          className="mt-1 block w-full text-sm text-gray-700 dark:text-gray-300" />
      </Field>
      {file && <p className="text-xs text-gray-600 dark:text-gray-400">Chosen: <span className="font-medium text-gray-900 dark:text-gray-100">{file.name}</span></p>}
    </div>
  );
}
