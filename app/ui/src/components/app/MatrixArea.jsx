import { lazy } from 'react';

// Lazy-load the matrix views (route-based code splitting).
const MatrixView = lazy(() => import('@ui/components/MatrixView'));
const RotatedMatrixView = lazy(() => import('@ui/components/RotatedMatrixView'));
const RollupMatrixView = lazy(() => import('@ui/components/RollupMatrixView'));

// The matrix tab body: one of the three matrix orientations. Which view renders
// is decided by the roll-up flag and the filter's orientation. (The wizard is
// mounted by AppMain — see MatrixWizardHost — so a refetch cannot destroy it.)
//
// `onShareView` only travels through here — the share dialog itself is owned by
// AppMain (#1166), because this component swaps one view component for another
// as soon as it learns the payload is a roll-up, destroying anything the
// outgoing view held. `onLoadSaved` is the wizard's own Apply handler: loading a
// saved matrix and applying one from the wizard are the same act (#1202).
//
export default function MatrixArea({
  rollup, data, matrixFilter, counts, missingContextIds, managedFilter, setManagedFilter,
  shareUrl, refreshing, onOpenDetail, onAdjustFilter, setMatrixFilter,
  accessPackageGroups, managedByPackages, resourceContexts, groupTagMap, hasData,
  onWizardApply, onShareView,
}) {
  return (
    <>
      {rollup ? (
        <RollupMatrixView
          rollup={rollup}
          filter={matrixFilter}
          counts={counts}
          missingContextIds={missingContextIds}
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
          missingContextIds={missingContextIds}
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
          missingContextIds={missingContextIds}
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
    </>
  );
}
