import { useState, useCallback, useMemo } from 'react';

// Folding a business role hides the rows of the resources that role grants (its
// `Contains` children), leaving only the role row itself. This is pure view
// state — the same tier as the column fold and the nested-group expand: it
// changes what is *rendered*, never what is fetched, counted or exported.
//
// The parent → child mapping is already modelled server-side
// (ResourceRelationships / relationshipType='Contains') and arrives in the
// matrix as the `accessPackageGroups` rows the SOLL columns are built from, so
// nothing is derived client-side that the data model doesn't already state.

// Bump when the stored shape changes; older entries are discarded on read.
export const ROLE_FOLD_VERSION = 1;

function foldStorageKey(matrixKey) {
  return `fgraph-rolefold-${matrixKey || 'all'}`;
}

// Read the folded-role ids saved for one matrix, discarding anything written by
// an older ROLE_FOLD_VERSION. Returns an empty Set when nothing is stored —
// business roles arrive expanded by default.
function readStoredFolds(matrixKey) {
  try {
    const raw = localStorage.getItem(foldStorageKey(matrixKey));
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved.version === ROLE_FOLD_VERSION && Array.isArray(saved.folded)) return new Set(saved.folded);
      localStorage.removeItem(foldStorageKey(matrixKey));
    }
  } catch {}
  return new Set();
}

function writeStoredFolds(matrixKey, folded) {
  try {
    if (folded.size === 0) localStorage.removeItem(foldStorageKey(matrixKey));
    else localStorage.setItem(foldStorageKey(matrixKey), JSON.stringify({
      version: ROLE_FOLD_VERSION,
      folded: [...folded],
    }));
  } catch {}
}

// Resource id a row stands for, normalised for case-insensitive matching against
// the access-package rows (owner/nested rows carry the real id separately).
export function rowResourceKey(row) {
  return String(row.realGroupId || row.id || '').toUpperCase();
}

// Business role → the resources it contains, from the access-package rows.
export function buildRoleChildMap(accessPackageGroups) {
  const map = new Map();
  for (const row of accessPackageGroups || []) {
    const roleId = String(row.accessPackageId || row.businessRoleId || '').toUpperCase();
    const childId = String(row.resourceId || row.groupId || '').toUpperCase();
    if (!roleId || !childId || roleId === childId) continue;
    if (!map.has(roleId)) map.set(roleId, new Set());
    map.get(roleId).add(childId);
  }
  return map;
}

// The resources the grid shows as top-level rows (nested sub-rows are not rows
// of their own — they come and go with the parent they hang under).
function topLevelRowIds(rows) {
  const ids = new Set();
  for (const row of rows || []) {
    if (!row.isNestedRow) ids.add(rowResourceKey(row));
  }
  return ids;
}

// Record one role as a parent of each of its resources that has a row, and
// return how many rows that role would fold away.
function linkRoleChildren(roleId, children, rowIds, rolesByChild) {
  let n = 0;
  for (const childId of children) {
    if (childId === roleId || !rowIds.has(childId)) continue;
    n++;
    if (!rolesByChild.has(childId)) rolesByChild.set(childId, new Set());
    rolesByChild.get(childId).add(roleId);
  }
  return n;
}

// Which roles in the grid can be folded, how many rows each one folds away, and
// — per contained resource — the roles that are actually present as rows.
// D4: a role with no row of its own gets no fold affordance and hides nothing,
// so a resource never vanishes without a visible parent to unfold it from.
export function analyseRoleRows(rows, childrenByRole) {
  const rowIds = topLevelRowIds(rows);
  const rolesByChild = new Map();
  const childCounts = new Map();
  for (const roleId of rowIds) {
    const children = childrenByRole.get(roleId);
    if (!children) continue;
    const n = linkRoleChildren(roleId, children, rowIds, rolesByChild);
    if (n > 0) childCounts.set(roleId, n);
  }
  return { foldableRoles: new Set(childCounts.keys()), rolesByChild, childCounts };
}

// A contained resource is hidden only when EVERY business role that grants it and
// is present in the grid is folded (D3) — an expanded role always shows its
// resources. A hidden row takes its own expanded nested sub-rows with it: those
// follow it in the list at a deeper nest level.
export function hideFoldedRows(rows, rolesByChild, folded) {
  if (!folded || folded.size === 0) return rows;
  const out = [];
  let dropDepth = null;
  for (const row of rows) {
    const depth = row.nestLevel || 0;
    if (dropDepth !== null) {
      if (depth > dropDepth) continue; // sub-row of a row we just dropped
      dropDepth = null;
    }
    const parents = row.isNestedRow ? null : rolesByChild.get(rowResourceKey(row));
    if (parents && parents.size > 0 && [...parents].every(id => folded.has(id))) {
      dropDepth = depth;
      continue;
    }
    out.push(row);
  }
  return out;
}

/**
 * Business-role fold state for the per-subject matrix.
 *
 * @param {object} args
 * @param {Array}  args.accessPackageGroups - (role, resource) rows from /api/access-package-groups
 * @param {Array}  args.rows                - the rows the grid would render unfolded
 * @param {string} args.storageKey          - stable string form of the matrix filter
 */
export function useBusinessRoleFold({ accessPackageGroups, rows, storageKey }) {
  const [foldedRoles, setFoldedRoles] = useState(() => readStoredFolds(storageKey));

  // Reload the saved folds when the matrix changes, during render rather than in
  // an effect (same pattern as useMatrixRowOrder) — fold state is per matrix, so
  // switching filters must never carry the previous matrix's folds across.
  const [seenKey, setSeenKey] = useState(storageKey);
  if (storageKey !== seenKey) {
    setSeenKey(storageKey);
    setFoldedRoles(readStoredFolds(storageKey));
  }

  const childrenByRole = useMemo(() => buildRoleChildMap(accessPackageGroups), [accessPackageGroups]);
  const { foldableRoles, rolesByChild, childCounts } = useMemo(
    () => analyseRoleRows(rows, childrenByRole), [rows, childrenByRole]);

  const applyFolds = useCallback((next) => {
    setFoldedRoles(next);
    writeStoredFolds(storageKey, next);
  }, [storageKey]);

  const toggleRoleFold = useCallback((roleId) => {
    const id = String(roleId || '').toUpperCase();
    const next = new Set(foldedRoles);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    applyFolds(next);
  }, [foldedRoles, applyFolds]);

  const foldAllRoles = useCallback(() => applyFolds(new Set(foldableRoles)), [foldableRoles, applyFolds]);
  const unfoldAllRoles = useCallback(() => applyFolds(new Set()), [applyFolds]);

  const visibleRows = useMemo(
    () => hideFoldedRows(rows, rolesByChild, foldedRoles), [rows, rolesByChild, foldedRoles]);

  const hasFoldedRoles = useMemo(
    () => [...foldableRoles].some(id => foldedRoles.has(id)), [foldableRoles, foldedRoles]);

  return {
    visibleRows,
    foldableRoles,
    foldedRoles,
    roleChildCounts: childCounts,
    toggleRoleFold,
    foldAllRoles,
    unfoldAllRoles,
    canFoldRoles: foldableRoles.size > 0,
    hasFoldedRoles,
  };
}
