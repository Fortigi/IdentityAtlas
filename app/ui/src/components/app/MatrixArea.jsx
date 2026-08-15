import { lazy } from 'react';

// Lazy-load the matrix views + filter wizard (route-based code splitting).
const MatrixView = lazy(() => import('@ui/components/MatrixView'));
const RotatedMatrixView = lazy(() => import('@ui/components/RotatedMatrixView'));
const RollupMatrixView = lazy(() => import('@ui/components/RollupMatrixView'));
const MatrixFilterWizard = lazy(() => import('@ui/components/matrix/MatrixFilterWizard'));

// The matrix tab body: one of the three matrix orientations plus the filter
// wizard modal. Which view renders is decided by the roll-up flag and the
// filter's orientation.
export default function MatrixArea({
  rollup, data, matrixFilter, counts, managedFilter, setManagedFilter,
  shareUrl, refreshing, onOpenDetail, onAdjustFilter, setMatrixFilter,
  accessPackageGroups, managedByPackages, resourceContexts, groupTagMap, hasData,
  wizardOpen, onWizardApply, onWizardClose,
}) {
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
        />
      )}
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
