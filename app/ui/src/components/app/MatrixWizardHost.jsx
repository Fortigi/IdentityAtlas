import { lazy } from 'react';

const MatrixFilterWizard = lazy(() => import('@ui/components/matrix/MatrixFilterWizard'));

// The matrix wizard, mounted by AppMain beside the share dialog and for the same
// reason (#1202): everything below AppMain's body switch is torn down while the
// app works — a matrix refetch swaps the whole body for the loading pane. With
// the wizard inside MatrixArea, an Adjust opened while a matrix was still
// loading was destroyed half-edited and came back on its first step.
//
// `wizardMode` ({ step, fresh }, see wizardOpening in App.helpers.js) is how it
// was asked to open: on a given step, and/or as a fresh, empty matrix rather
// than the one on screen.
export default function MatrixWizardHost({
  matrixFilter, managedFilter, wizardOpen, wizardMode, onWizardApply, onWizardClose,
}) {
  const fresh = wizardMode?.fresh === true;
  return (
    <MatrixFilterWizard
      open={!!wizardOpen}
      initialFilter={fresh ? null : matrixFilter}
      initialManaged={fresh ? 'all' : managedFilter}
      initialStep={wizardMode?.step || undefined}
      onApply={onWizardApply}
      onClose={onWizardClose}
    />
  );
}
