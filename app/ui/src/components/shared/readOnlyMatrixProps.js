// The props a read-only matrix shell hands the matrix views (MatrixArea): the
// loaded matrix (useMatrix), its filter and the viewer's own Governed toggle —
// no wizard, no filter editing. Shared by a share recipient's page
// (SharedMatrixPage) and a context owner's team matrix (OwnerTeamMatrix).
export function readOnlyMatrixProps({ matrix, filter, managedFilter, setManagedFilter, onOpenDetail, noop }) {
  return {
    rollup: matrix.rollup,
    data: matrix.data,
    matrixFilter: filter,
    counts: matrix.counts,
    managedFilter,
    setManagedFilter,
    refreshing: matrix.refreshing,
    onOpenDetail,
    setMatrixFilter: noop,
    accessPackageGroups: matrix.accessPackageGroups,
    managedByPackages: matrix.managedByPackages,
    resourceContexts: matrix.resourceContexts,
    groupTagMap: matrix.groupTagMap,
    hasData: matrix.hasData,
    wizardOpen: false,
    onAdjustFilter: noop,
    onWizardApply: noop,
    onWizardClose: noop,
  };
}
