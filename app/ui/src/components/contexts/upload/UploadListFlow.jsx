import { useAuth } from '@ui/auth/AuthGate';
import { ErrorBox, PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import { useContextUpload } from './useContextUpload';
import { mappingProblems, stepFooter, UPLOAD_STEPS } from './uploadMapping.helpers';
import UploadFileStep from './UploadFileStep';
import UploadMappingStep from './UploadMappingStep';
import UploadPreviewStep from './UploadPreviewStep';

// The "Upload a list" path of the New context tree wizard, from its second
// step on (the wizard owns the step number and the Stepper):
//   2 File     the list, and whether it updates one uploaded before
//   3 Mapping  the best guess, every field changeable
//   4 Preview  what would change → Import
// `reimportListId` opens it on a list chosen from the tree's ⋯ menu; the list
// is then fixed and Back does not lead to the source cards.

export default function UploadListFlow({ step, onStep, onBackToSource, reimportListId = null, onImported }) {
  const { authFetch } = useAuth();
  const u = useContextUpload(authFetch, { initialListId: reimportListId });
  const updating = !!u.listId;
  const offer = !updating && u.analysis?.existingList ? u.analysis.existingList : null;

  async function next() {
    if (step === UPLOAD_STEPS.file) { if (await u.analyze()) onStep(UPLOAD_STEPS.mapping); return; }
    if (step === UPLOAD_STEPS.mapping) { if (await u.runPreview()) onStep(UPLOAD_STEPS.preview); return; }
    const result = await u.apply();
    if (result) onImported(result);
  }
  function back() {
    if (step === UPLOAD_STEPS.file) { onBackToSource(); return; }
    onStep(step - 1);
  }

  const problems = u.mapping ? mappingProblems(u.mapping) : [];
  const footer = stepFooter(step, { file: u.file, problems, preview: u.preview, updating, reimporting: !!reimportListId });

  return (
    <div>
      {step === UPLOAD_STEPS.file && (
        <UploadFileStep file={u.file} onFile={u.setFile} lists={u.lists} listId={u.listId} onChooseList={u.chooseList} locked={!!reimportListId} />
      )}
      {step === UPLOAD_STEPS.mapping && u.mapping && (
        <UploadMappingStep analysis={u.analysis} mapping={u.mapping} onChange={u.setMapping} listLocked={updating}
          existingOffer={offer} onUseExisting={() => u.chooseList(offer.id)} />
      )}
      {step === UPLOAD_STEPS.preview && (
        <UploadPreviewStep preview={u.preview} updating={updating} removeMissing={u.removeMissing} onRemoveMissing={u.setRemoveMissing} />
      )}
      <ErrorBox message={u.error} />
      <div className="mt-5 flex items-center justify-between gap-2">
        <div className="text-[11px] text-gray-600 dark:text-gray-400">{step === UPLOAD_STEPS.mapping && problems.join(' ')}</div>
        <div className="flex items-center gap-2">
          {footer.showBack && <SecondaryButton onClick={back} disabled={u.busy}>Back</SecondaryButton>}
          <PrimaryButton onClick={next} disabled={footer.blocked || u.busy}>{u.busy ? 'Working…' : footer.label}</PrimaryButton>
        </div>
      </div>
    </div>
  );
}
