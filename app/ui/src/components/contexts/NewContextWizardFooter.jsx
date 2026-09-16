import { PrimaryButton, SecondaryButton } from './ModalPrimitives';
import { runLabel, runDisabled, nextLabel } from './NewContextWizard.helpers';

// Wizard footer: the "Missing: …" hint on the left, Back + the context-aware
// primary button on the right.
export default function WizardFooter({
  source, step, pluginMissing, showBack, onBack,
  running, dryRunning, mode, refreshKey, manualValid, creating, canNext,
  onRun, onCreate, onNext,
}) {
  return (
    <div className="mt-5 flex items-center justify-between gap-2">
      <FooterHint source={source} step={step} pluginMissing={pluginMissing} />
      <div className="flex items-center gap-2">
        {showBack && <SecondaryButton onClick={onBack}>Back</SecondaryButton>}
        <WizardPrimaryButton
          source={source} step={step}
          running={running} dryRunning={dryRunning} mode={mode} refreshKey={refreshKey}
          manualValid={manualValid} creating={creating} canNext={canNext}
          onRun={onRun} onCreate={onCreate} onNext={onNext}
        />
      </div>
    </div>
  );
}

function FooterHint({ source, step, pluginMissing }) {
  const show = source === 'plugin' && step === 3 && pluginMissing.length > 0;
  return (
    <div className="text-[11px] text-gray-500 dark:text-gray-400">
      {show ? `Missing: ${pluginMissing.join(', ')}` : ''}
    </div>
  );
}

function WizardPrimaryButton({
  source, step, running, dryRunning, mode, refreshKey,
  manualValid, creating, canNext, onRun, onCreate, onNext,
}) {
  if (source === 'plugin' && step === 4) {
    return (
      <PrimaryButton onClick={onRun} disabled={runDisabled(running, dryRunning, mode, refreshKey)}>
        {runLabel(running, mode)}
      </PrimaryButton>
    );
  }
  if (source === 'manual' && step === 2) {
    return (
      <PrimaryButton onClick={onCreate} disabled={!manualValid || creating}>
        {creating ? 'Creating…' : 'Create'}
      </PrimaryButton>
    );
  }
  return (
    <PrimaryButton onClick={onNext} disabled={!canNext}>
      {nextLabel(step, source)}
    </PrimaryButton>
  );
}
