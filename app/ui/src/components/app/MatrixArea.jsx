import { lazy, Suspense, useState } from 'react';

// Lazy-load the matrix views + filter wizard (route-based code splitting).
const MatrixView = lazy(() => import('@ui/components/MatrixView'));
const RotatedMatrixView = lazy(() => import('@ui/components/RotatedMatrixView'));
const RollupMatrixView = lazy(() => import('@ui/components/RollupMatrixView'));
const MatrixFilterWizard = lazy(() => import('@ui/components/matrix/MatrixFilterWizard'));
const ShareMatrixDialog = lazy(() => import('@ui/components/matrix/ShareMatrixDialog'));

// The matrix tab body: one of the three matrix orientations plus the filter
// wizard modal. Which view renders is decided by the roll-up flag and the
// filter's orientation.
//
// The share dialog is owned HERE, not by the toolbar button that opens it
// (#1166). Which of the three views renders is data-dependent, so the moment a
// roll-up payload lands — or the orientation changes — React unmounts one view
// and mounts another, taking every piece of state inside it with it. With the
// dialog living in the toolbar that meant an open share dialog silently
// vanished, half-typed, the instant a slow matrix finished loading. This level
// survives the swap, so the dialog does too.
export default function MatrixArea({
  rollup, data, matrixFilter, counts, managedFilter, setManagedFilter,
  shareUrl, refreshing, onOpenDetail, onAdjustFilter, setMatrixFilter,
  accessPackageGroups, managedByPackages, resourceContexts, groupTagMap, hasData,
  wizardOpen, onWizardApply, onWizardClose,
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const openShare = () => setShareOpen(true);

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
          onShareView={openShare}
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
          hasData={hasData}
          onShareView={openShare}
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
          hasData={hasData}
          onShareView={openShare}
        />
      )}
      {/* Its own boundary: the dialog is a lazy chunk, and without one the
          shell's Suspense would blank the whole matrix while it loads. */}
      <Suspense fallback={null}>
        {shareOpen && (
          <ShareMatrixDialog
            filter={matrixFilter}
            managed={managedFilter}
            onClose={() => setShareOpen(false)}
          />
        )}
      </Suspense>
      <MatrixFilterWizard
        open={wizardOpen}
        initialFilter={matrixFilter}
        initialManaged={managedFilter}
        onApply={onWizardApply}
        onClose={onWizardClose}
      />
    </>
  );
}
