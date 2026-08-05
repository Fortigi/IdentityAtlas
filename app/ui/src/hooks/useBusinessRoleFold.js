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
  const rolesByChild = new Map();
  const childCounts = new Map();
  for (const roleId of rowIds) {
    const children = childrenByRole.get(roleId);
    if (!children) continue;
    const n = linkRoleChildren(roleId, children, rowIds, rolesByChild);
    if (n > 0) childCounts.set(roleId, n);
  }
  return {
    foldableRoles: new Set(childCounts.keys()),
    rolesByChild,
    childCounts,
    roleNames: rowNames(rows),
  };
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

// The top-level rows a fold has any say over: every row granted by at least one
// FOLDED role, with the roles granting it and whether every one of them is
// folded — the same rule hideFoldedRows applies, so a row that is still on
// screen because another role that grants it is expanded comes back as
// `hidden: false`. Both consumers below walk the grid through here, so what a
// folded role reports can never disagree with what it actually took away.
function* foldedRowParents(rows, rolesByChild, folded) {
  for (const row of rows) {
    if (row.isNestedRow) continue;
    const parents = rolesByChild.get(rowResourceKey(row));
    if (!parents?.size) continue;
    const roles = [...parents];
    if (!roles.some(id => folded.has(id))) continue;
    yield { row, roles, hidden: roles.every(id => folded.has(id)) };
  }
}

// The rows each folded role took away, keyed by role id. A resource granted by
// two folded roles is listed under both, since either one can bring it back;
// one still shown by an expanded role is listed under neither. Used to
// summarise, on the folded role's own row, the access hiding underneath it.
export function collectFoldedChildRows(rows, rolesByChild, folded) {
  const byRole = new Map();
  if (!folded || folded.size === 0) return byRole;
  for (const { row, roles, hidden } of foldedRowParents(rows, rolesByChild, folded)) {
    if (!hidden) continue;
    for (const id of roles) {
      if (!byRole.has(id)) byRole.set(id, []);
      byRole.get(id).push(row);
    }
  }
  return byRole;
}

// Turn each role's "still shown by" id set into display names, once the walk is
// over.
function nameSharingRoles(info, roleNames) {
  for (const entry of info.values()) {
    entry.shownBy = [...entry.shownBy].map(id => roleNames?.get(id) || id);
  }
  return info;
}

/**
 * Per foldable role: how many of the resources it grants have a row (`total`),
 * how many of those its fold actually took away (`hidden`), and which still-
 * expanded roles are keeping the rest on screen (`shownBy`).
 *
 * A resource granted by several business roles only disappears once every one
 * of them is folded, so `hidden` can be lower than `total` — the role row says
 * so rather than claiming rows it did not take.
 *
 * @returns {Map<string, {total: number, hidden: number, shownBy: string[]}>}
 */
export function summariseFolds(rows, rolesByChild, childCounts, folded, roleNames) {
  const foldedSet = folded || new Set();
  const info = new Map();
  for (const [roleId, total] of childCounts) info.set(roleId, { total, hidden: 0, shownBy: new Set() });
  for (const { roles, hidden } of foldedRowParents(rows, rolesByChild, foldedSet)) {
    tallyFoldedRow(info, roles, hidden, foldedSet);
  }
  return nameSharingRoles(info, roleNames);
}

// One resource row a fold reached, against every folded role that grants it:
// either the fold took the row away, or a role that is still expanded is
// keeping it on screen — and that role gets named on the folded one.
function tallyFoldedRow(info, roles, hidden, foldedSet) {
  const stillShowing = roles.filter(id => !foldedSet.has(id));
  for (const id of roles) {
    const entry = foldedSet.has(id) ? info.get(id) : null;
    if (!entry) continue;
    if (hidden) entry.hidden++;
    else for (const other of stillShowing) entry.shownBy.add(other);
  }
}

// The roles granting a resource that its own row does not already sit under,
// as [{id, name}] — what the row has to say for itself once position stops
// answering the question. Rows are draggable and keep their new position, so a
// resource can be moved away from (or above) the role that grants it; the
// answer therefore has to live on the row, not in the layout.
function detachedOwners(key, rolesByChild, roleNames, parentId, folded) {
  const owners = [];
  for (const id of rolesByChild.get(key) || []) {
    if (id === parentId) continue;
    owners.push({ id, name: roleNames?.get(id) || id });
  }
  // The chip labels itself with the first name, so lead with a role that is
  // still expanded: when one role granting the resource is folded and another
  // is not, the expanded one is why the row is still on screen.
  return owners.sort((a, b) => (folded?.has(a.id) ? 1 : 0) - (folded?.has(b.id) ? 1 : 0));
}

// Mark up one resource row: the role it is drawn beneath (adjacent, so it gets
// the indent + elbow) and the granting roles it is NOT beneath (named on the
// row itself). `roleGrantedBy` lists every granting role for the row tooltip,
// so the question is answerable from any position, and `roleGrantIds` carries
// the same list as ids — that is what lets a cell say whether the subject's
// membership actually came through one of those roles.
function markResourceRow(row, key, { rolesByChild, roleNames, folded }, parentId) {
  const roles = rolesByChild.get(key);
  if (!roles?.size) return row;
  const owners = detachedOwners(key, rolesByChild, roleNames, parentId, folded);
  const marked = {
    ...row,
    roleGrantedBy: [...roles].map(id => roleNames?.get(id) || id).join(', '),
    roleGrantIds: [...roles],
  };
  if (parentId) marked.roleParentId = parentId;
  if (owners.length) marked.roleOwners = owners;
  return marked;
}

// Mark the resources that sit directly beneath the business role granting them
// (the AP staircase puts them there) so the grid can render them as that role's
// children — the same indent + elbow an expanded nested group already uses. A
// resource that is not adjacent to one of its roles stays a plain top-level row
// rather than being indented under an unrelated one, and carries the name of
// the role(s) that grant it instead.
export function markRoleChildren(rows, foldableRoles, rolesByChild, roleNames, folded) {
  if (!foldableRoles || foldableRoles.size === 0) return rows;
  const out = [];
  // Where the walk currently stands: the role block we are inside, and the role
  // the last top-level row was drawn under.
  const pos = { roleId: null, childOf: null };
  let marked = false;
  for (const row of rows) {
    const next = markOneRow(row, { foldableRoles, rolesByChild, roleNames, folded }, pos);
    if (next !== row) marked = true;
    out.push(next);
  }
  return marked ? out : rows;
}

// One row of that walk: advances `pos` and returns the row as it should render.
function markOneRow(row, opts, pos) {
  const { foldableRoles, rolesByChild, folded } = opts;
  // Sub-rows follow the row they were expanded from, so they inherit its place
  // in the role block.
  if (row.isNestedRow) return pos.childOf ? { ...row, roleParentId: pos.childOf } : row;

  const key = rowResourceKey(row);
  if (foldableRoles.has(key)) {
    // A FOLDED role adopts nothing. Its own resources are gone, so a resource
    // still drawn below it is only there because another role grants it —
    // indenting it under a collapsed role would claim the opposite. It becomes
    // a plain row that names its roles instead.
    pos.roleId = folded?.has(key) ? null : key;
    pos.childOf = null;
    return row;
  }
  pos.childOf = pos.roleId && rolesByChild.get(key)?.has(pos.roleId) ? pos.roleId : null;
  if (!pos.childOf) pos.roleId = null;
  return markResourceRow(row, key, opts, pos.childOf);
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
  const { foldableRoles, rolesByChild, childCounts, roleNames } = useMemo(
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
    () => markRoleChildren(
      hideFoldedRows(rows, rolesByChild, foldedRoles), foldableRoles, rolesByChild, roleNames, foldedRoles),
    [rows, rolesByChild, foldedRoles, foldableRoles, roleNames]);

  const foldedChildRows = useMemo(
    () => collectFoldedChildRows(rows, rolesByChild, foldedRoles), [rows, rolesByChild, foldedRoles]);

  // What each role's fold really took away — `hidden` trails `total` when a
  // resource it grants is still shown by another role that is not folded.
  const roleFoldInfo = useMemo(
    () => summariseFolds(rows, rolesByChild, childCounts, foldedRoles, roleNames),
    [rows, rolesByChild, childCounts, foldedRoles, roleNames]);

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
