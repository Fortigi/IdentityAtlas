import { lazy } from 'react';

// Lazy-load the matrix views + filter wizard (route-based code splitting).
const MatrixView = lazy(() => import('@ui/components/MatrixView'));
const RotatedMatrixView = lazy(() => import('@ui/components/RotatedMatrixView'));
const RollupMatrixView = lazy(() => import('@ui/components/RollupMatrixView'));
const MatrixFilterWizard = lazy(() => import('@ui/components/matrix/MatrixFilterWizard'));

// The matrix tab body: one of the three matrix orientations plus the filter
// wizard modal. Which view renders is decided by the roll-up flag and the
// filter's orientation.
//
// `onShareView` only travels through here — the share dialog itself is owned by
// AppMain (#1166), because this component swaps one view component for another
// as soon as it learns the payload is a roll-up, destroying anything the
// outgoing view held. `onLoadSaved` is the wizard's own Apply handler: loading a
// saved matrix and applying one from the wizard are the same act (#1202).
//
// `onAdjustFilter(options?)` opens the wizard; `wizardMode` ({ step, fresh }, see
// wizardOpening in App.helpers.js) is how it was asked to open: on a given step,
// and/or as a fresh, empty matrix rather than the one on screen.
export default function MatrixArea({
  rollup, data, matrixFilter, counts, managedFilter, setManagedFilter,
  shareUrl, refreshing, onOpenDetail, onAdjustFilter, setMatrixFilter,
  accessPackageGroups, managedByPackages, resourceContexts, groupTagMap, hasData,
  wizardOpen, wizardMode, onWizardApply, onWizardClose, onShareView,
}) {
  const fresh = wizardMode?.fresh === true;
  return (
    <>
      {rollup ? (
        <RollupMatrixView
          rollup={rollup}
          filter={matrixFilter}
          counts={counts}
          managedFilter={managedFilter}
          setManagedFilter={setManagedFilter}
          shareUrl={shareUrl}
          refreshing={refreshing}
          onOpenDetail={onOpenDetail}
          onAdjustFilter={onAdjustFilter}
          onFilterChange={setMatrixFilter}
          onLoadSaved={onWizardApply}
          onShareView={onShareView}
        />
      ) : matrixFilter?.orientation === 'rows-as-subjects' ? (
        <RotatedMatrixView
          data={data}
          filter={matrixFilter}
          counts={counts}
          managedFilter={managedFilter}
          setManagedFilter={setManagedFilter}
          refreshing={refreshing}
          shareUrl={shareUrl}
          onOpenDetail={onOpenDetail}
          onAdjustFilter={onAdjustFilter}
          onLoadSaved={onWizardApply}
          hasData={hasData}
          onShareView={onShareView}
        />
      ) : (
        <MatrixView
          data={data}
          accessPackageGroups={accessPackageGroups}
          managedByPackages={managedByPackages}
          resourceContexts={resourceContexts}
          filter={matrixFilter}
          counts={counts}
          managedFilter={managedFilter}
          setManagedFilter={setManagedFilter}
          groupTagMap={groupTagMap}
          refreshing={refreshing}
          shareUrl={shareUrl}
          onOpenDetail={onOpenDetail}
          onAdjustFilter={onAdjustFilter}
          onLoadSaved={onWizardApply}
          hasData={hasData}
          onShareView={onShareView}
        />
      )}
      <MatrixFilterWizard
        open={wizardOpen}
        initialFilter={fresh ? null : matrixFilter}
        initialManaged={fresh ? 'all' : managedFilter}
        initialStep={wizardMode?.step || undefined}
        onApply={onWizardApply}
        onClose={onWizardClose}
      />
    </>
  );
}
