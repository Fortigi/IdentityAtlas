// Organisation → Import wizard (workstream T5).
//
// Six steps on WizardShell + Stepper (see the handover for the contract):
//   1 Start      new import, or repeat an import profile (full / delta, adjust the config?)
//   2 Source     upload the list (POST /api/org-truth/sources), observed date
//   3 Model      column profile + proposed recipe (POST /api/org-truth/propose/recipe), editable
//   4 Links      per entity type: detected candidate fields (POST /api/org-truth/links/detect), accept as signals
//   5 Quality    dry-run (POST /api/org-truth/runs/dry-run): unique / ambiguous / none, threshold, per-row feedback
//   6 Confirm    save the profile (POST/PUT /api/org-truth/profiles), start the run (POST /api/org-truth/runs), poll it
//
// Props: { onClose(imported: boolean), profileId? }
import WizardShell from '@ui/components/WizardShell';
import NotBuiltYet from '@ui/components/orgtruth/NotBuiltYet';

export default function ImportWizard({ onClose }) {
  return (
    <WizardShell title="Import organisation truth" onCancel={() => onClose(false)}>
      <NotBuiltYet what="Import wizard" workstream="T5" />
    </WizardShell>
  );
}
