import { useMemo } from 'react';
import { useBusinessRoleFold } from './useBusinessRoleFold';
import { buildRoleDeviationCounts, NO_ROLE_DEVIATIONS } from '@ui/components/matrix/coverageDeviation';

// The matrix's business-role layer, as one thing the grid can switch on or off.
//
// A matrix opts into it with `filter.includeBusinessRoles` — the wizard's "Show
// business roles as foldable rows". Ticked, the server puts business roles on
// the resource axis and this hook lays the grid out around them: each role
// adopts the resources it grants, folding a role hides them, and a folded role
// keeps a tally per subject of what it does not account for. Unticked, there are
// no business-role rows to begin with, so every one of those answers is the
// empty one and the grid is exactly what it was before the layer existed.
//
// It lives outside MatrixView for the same reason the column model and the
// nested-row builder do: MatrixView is an orchestrator, and four more
// conditionals in it buy nothing that a named hook does not say better. The
// pieces it composes are tested in their own right (useBusinessRoleFold,
// coverageDeviation); what is tested HERE is the switch itself.
//
// @param {object}   args
// @param {object}   args.filter              the matrix definition (carries the opt-in)
// @param {Array}    args.accessPackageGroups (role, resource) rows behind the SOLL columns
// @param {Array}    args.rows                the rows the grid would render without the layer
// @param {string}   args.storageKey          stable string form of the matrix filter
// @param {Array}    args.exportBase          rows the Excel export writes when the layer is off
// @param {Array}    args.users               subject columns, aggregates included
// @param {Map}      args.memberships         per-cell membership types, column-resolved
// @param {Map}      args.managedApMap        server coverage: "resource|subject" → role ids
// @param {Map}      args.apGroupMap          SOLL mapping: "RESOURCE|role" → roleName
// @param {Map}      args.userToAgg           subject id → the aggregate column holding it
export function useMatrixBusinessRoleLayer({
  filter, accessPackageGroups, rows, storageKey, exportBase,
  users, memberships, managedApMap, apGroupMap, userToAgg,
}) {
  // Strict `=== true`, matching the API's parseFilter and the wizard's
  // normaliser: a stray truthy value must not quietly switch the layer on.
  const enabled = filter?.includeBusinessRoles === true;

  // Starving the fold of its (role, resource) pairs is what makes the layer
  // absent rather than merely hidden: with no pairs there are no foldable
  // roles, no row gets a parent, and every affordance downstream is inert.
  const fold = useBusinessRoleFold({
    accessPackageGroups: enabled ? accessPackageGroups : null,
    rows,
    storageKey,
  });

  // Per (folded role, subject): how the rows a role folded away deviate from
  // what it assigns — more than it grants, and less. Folding is a summary,
  // never a cover-up, so both counts ride along on the folded row. Coverage is
  // the server's business-role mapping, never a client-side guess at what a
  // role ought to grant.
  const deviations = useMemo(() => buildRoleDeviationCounts({
    foldedChildRows: fold.foldedChildRows,
    users, memberships, managedApMap, apGroupMap, userToAgg,
  }) || NO_ROLE_DEVIATIONS,
  [fold.foldedChildRows, users, memberships, managedApMap, apGroupMap, userToAgg]);

  return {
    enabled,
    // What the grid renders, and what the Excel export writes. The export
    // always mirrors the grid's structure but never its folds — folding is a
    // reading aid and must not drop access from a file a review is signed off
    // against. With the layer off it is the plain row order, untouched.
    rows: fold.visibleRows,
    exportRows: enabled ? fold.exportRows : exportBase,
    foldableRoles: fold.foldableRoles,
    foldedRoles: fold.foldedRoles,
    roleFoldInfo: fold.roleFoldInfo,
    extraCounts: deviations.extra,
    missingCounts: deviations.missing,
    toggleRoleFold: fold.toggleRoleFold,
    foldAllRoles: fold.foldAllRoles,
    unfoldAllRoles: fold.unfoldAllRoles,
    canFoldRoles: fold.canFoldRoles,
    hasFoldedRoles: fold.hasFoldedRoles,
  };
}

export default useMatrixBusinessRoleLayer;
