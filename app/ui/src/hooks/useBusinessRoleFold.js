import { useState, useCallback, useMemo } from 'react';

// A business role owns the rows of the resources it grants (its `Contains`
// children): they are drawn beneath it as its children, and folding the role
// hides them, leaving only the role row itself. A resource that several business
// roles grant gets a row under EACH of them — the catalogue overlap is the thing
// an analyst is looking for, and one row filed under the "first" role hid it
// (requestor feedback on #370). This is pure view state — the same tier as the
// column fold and the nested-group expand: it changes what is *rendered*, never
// what is fetched, counted or exported.
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
// return how many rows that role would fold away. A business role nested inside
// another one keeps its own place in the grid rather than being filed under its
// parent, so it is not counted here either.
function linkRoleChildren(roleId, children, rowIds, roleRowIds, rolesByChild) {
  let n = 0;
  for (const childId of children) {
    if (childId === roleId || !rowIds.has(childId) || roleRowIds.has(childId)) continue;
    n++;
    if (!rolesByChild.has(childId)) rolesByChild.set(childId, new Set());
    rolesByChild.get(childId).add(roleId);
  }
  return n;
}

// Display name of every row, keyed by resource id — so a resource can name the
// business role that grants it without a second lookup table.
function rowNames(rows) {
  const names = new Map();
  for (const row of rows || []) {
    if (!row.isNestedRow) names.set(rowResourceKey(row), row.displayName || row.id);
  }
  return names;
}

// Which roles in the grid can be folded, how many rows each one folds away, and
// — per contained resource — the roles that are actually present as rows.
// D4: a role with no row of its own gets no fold affordance and hides nothing,
// so a resource never vanishes without a visible parent to unfold it from.
export function analyseRoleRows(rows, childrenByRole) {
  const rowIds = topLevelRowIds(rows);
  const roleRowIds = new Set([...rowIds].filter(id => childrenByRole.has(id)));
  const rolesByChild = new Map();
  const childCounts = new Map();
  for (const roleId of roleRowIds) {
    const n = linkRoleChildren(roleId, childrenByRole.get(roleId), rowIds, roleRowIds, rolesByChild);
    if (n > 0) childCounts.set(roleId, n);
  }
  return {
    foldableRoles: new Set(childCounts.keys()),
    rolesByChild,
    childCounts,
    roleNames: rowNames(rows),
  };
}

// The grid as movable units: one top-level row plus the nested sub-rows that
// were expanded underneath it. A block is what a business role adopts and what a
// fold takes away — sub-rows can never be separated from the row they hang
// under.
function rowBlocks(rows) {
  const blocks = [];
  for (const row of rows || []) {
    if (row.isNestedRow && blocks.length) blocks[blocks.length - 1].rows.push(row);
    else blocks.push({ head: row, rows: [row] });
  }
  return blocks;
}

// One rendering of a resource beneath one of the business roles that grants it.
// `rowKey` disambiguates the copies for React and the drag layer; everything
// else (`id`, `realGroupId`) stays the resource's own, so cell lookups, nested
// expansion and the detail links are the same from any of its rows.
function roleChildRows(block, roleId, rolesByChild, roleNames) {
  const roles = [...(rolesByChild.get(rowResourceKey(block.head)) || [])];
  const name = id => roleNames?.get(id) || id;
  const others = roles.filter(id => id !== roleId).map(id => ({ id, name: name(id) }));
  const head = {
    ...block.head,
    rowKey: `${roleId}::${block.head.id}`,
    roleParentId: roleId,
    roleGrantedBy: roles.map(name).join(', '),
    roleGrantIds: roles,
  };
  if (others.length) head.roleOwners = others;
  return [
    head,
    // Sub-rows follow the row they were expanded from into the role's block.
    ...block.rows.slice(1).map(row => ({
      ...row, rowKey: `${roleId}::${row.id}`, roleParentId: roleId,
    })),
  ];
}

// Which blocks each business role adopts, in the order the grid already has
// them, plus the blocks that are therefore drawn under a role rather than on
// their own. A block granted by two roles is adopted by both.
function adoptRoleChildren(blocks, foldableRoles, rolesByChild) {
  const childBlocks = new Map();
  const adopted = new Set();
  for (const block of blocks) {
    const key = rowResourceKey(block.head);
    if (block.head.isNestedRow || foldableRoles.has(key)) continue;
    for (const roleId of rolesByChild.get(key) || []) {
      adopted.add(block);
      if (!childBlocks.has(roleId)) childBlocks.set(roleId, []);
      childBlocks.get(roleId).push(block);
    }
  }
  return { childBlocks, adopted };
}

/**
 * Lay the grid out around its business roles: every resource a role grants is
 * drawn as that role's child, under each role that grants it, and disappears
 * from a role that is folded.
 *
 * A resource is rendered ONLY under its roles — never also as a loose row
 * elsewhere — so the number of times it appears is exactly the number of roles
 * that hand it out, and a fold takes away exactly what its role grants.
 *
 * @param {Array}  rows     - the rows the grid would render without the fold
 * @param {object} analysis - the output of analyseRoleRows
 * @param {Set}    folded   - ids of the folded roles
 * @returns {{visibleRows: Array, roleFoldInfo: Map, foldedChildRows: Map}}
 */
export function buildRoleLayout(rows, { foldableRoles, rolesByChild, roleNames }, folded) {
  const foldedSet = folded || new Set();
  const blocks = rowBlocks(rows);
  const { childBlocks, adopted } = adoptRoleChildren(blocks, foldableRoles, rolesByChild);

  const visibleRows = [];
  const roleFoldInfo = new Map();
  const foldedChildRows = new Map();
  for (const block of blocks) {
    if (adopted.has(block)) continue; // drawn under the role(s) granting it
    visibleRows.push(...block.rows);
    const key = rowResourceKey(block.head);
    if (block.head.isNestedRow || !foldableRoles.has(key)) continue;
    const children = childBlocks.get(key) || [];
    roleFoldInfo.set(key, { total: children.length });
    if (foldedSet.has(key)) foldedChildRows.set(key, children.map(b => b.head));
    else for (const c of children) visibleRows.push(...roleChildRows(c, key, rolesByChild, roleNames));
  }
  return { visibleRows, roleFoldInfo, foldedChildRows };
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
  const analysis = useMemo(() => analyseRoleRows(rows, childrenByRole), [rows, childrenByRole]);
  const { foldableRoles } = analysis;

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

  const { visibleRows, roleFoldInfo, foldedChildRows } = useMemo(
    () => buildRoleLayout(rows, analysis, foldedRoles), [rows, analysis, foldedRoles]);

  const hasFoldedRoles = useMemo(
    () => [...foldableRoles].some(id => foldedRoles.has(id)), [foldableRoles, foldedRoles]);

  return {
    visibleRows,
    foldedChildRows,
    foldableRoles,
    foldedRoles,
    roleFoldInfo,
    toggleRoleFold,
    foldAllRoles,
    unfoldAllRoles,
    canFoldRoles: foldableRoles.size > 0,
    hasFoldedRoles,
  };
}
