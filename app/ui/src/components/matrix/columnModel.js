// Pure model for the matrix subject (column) axis: which subjects render as their
// own column, which fold into an aggregate "count" column, and which explode into
// individual member columns at a folded level. Extracted from MatrixView so the
// (previously huge) transform is unit-testable and stays under the complexity gate.

// Marks an aggregate column's sort-key values BELOW its collapse level, so the
// merged header renders a child-count there (and two aggregate columns never fuse
// into one span). Picked from the private-use area so it can't collide with real
// attribute values.
export const AGG_SENTINEL = '@@AGG@@';

// Key identifying a collapsed attribute group: the level plus the sort-key prefix
// up to and including `level`. Each segment is length-prefixed so two different
// value sequences can never collide.
export function collapseKey(sortKeys, level) {
  const seg = (sortKeys || []).slice(0, level + 1).map(v => `${String(v).length}:${v}`).join('|');
  return `${level}|${seg}`;
}

// A per-account sub-column spliced in under an expanded identity (or member),
// inheriting the parent's sort-keys so the merged attribute headers stay contiguous.
export function makeAccountCol(parent, acc, sortKeys) {
  return {
    id: acc.id,
    displayName: acc.displayName || acc.id,
    jobTitle: parent.jobTitle || '',
    department: parent.department || '',
    upn: '',
    memberType: 'Principal',
    isAccountCol: true,
    parentId: parent.id,
    accountType: acc.accountType || null,
    isPrimary: !!acc.isPrimary,
    sortKeys: [...(sortKeys || [])],
  };
}

// Shallowest collapsed level whose sort-key prefix covers this subject, or -1.
function shallowestCollapsedLevel(sortKeys, nAttr, collapsed) {
  for (let L = 0; L < nAttr; L++) {
    if (collapsed.has(collapseKey(sortKeys, L))) return L;
  }
  return -1;
}

// sort-keys truncated to `lvl` (values above the level blanked) — member columns
// sit under the current header without sprouting deeper attribute rows.
function truncateSortKeys(sortKeys, lvl, nAttr) {
  const sk = [];
  for (let i = 0; i < nAttr; i++) sk[i] = i <= lvl ? (sortKeys?.[i] ?? '') : '';
  return sk;
}

// sort-keys for an aggregate column: real values up to the collapse level; a
// unique sentinel below so merged header spans never fuse two aggregates.
function aggregateSortKeys(sortKeys, lvl, nAttr, aggId) {
  const sk = [];
  for (let i = 0; i < nAttr; i++) sk[i] = i <= lvl ? (sortKeys?.[i] ?? '') : `${AGG_SENTINEL}${aggId} ${i}`;
  return sk;
}

// Distinct child-value count for each level below the collapse level.
function childCountsBelow(members, lvl, nAttr) {
  const childCounts = {};
  for (let i = lvl + 1; i < nAttr; i++) {
    childCounts[i] = new Set(members.map(m => (m.sortKeys?.[i] ?? ''))).size;
  }
  return childCounts;
}

// Push a subject's account sub-columns, when it's an expanded identity.
function appendAccountCols(out, parent, sortKeys, ctx) {
  if (parent.memberType !== 'Identity' || !ctx.expandedIdentities.has(parent.id)) return;
  const cache = ctx.accountMatrixCache.get(parent.id);
  for (const acc of (cache?.accounts || [])) out.push(makeAccountCol(parent, acc, sortKeys));
}

// Push a real subject column followed by its account sub-columns.
function pushSubjectWithAccounts(out, col, accountSortKeys, ctx) {
  out.push(col);
  appendAccountCols(out, col, accountSortKeys, ctx);
}

// Member-expanded: show the individual subjects at this level instead of one
// aggregate. `direct` keeps only subjects whose path ends here.
function emitMemberColumns(out, members, info, ctx) {
  const { key, lvl, nAttr, memMode } = info;
  const picked = memMode === 'direct'
    ? members.filter(m => !(m.sortKeys?.[lvl + 1]))
    : members;
  for (const m of picked) {
    const sk = truncateSortKeys(m.sortKeys, lvl, nAttr);
    const col = { ...m, sortKeys: sk, isMemberCol: true, aggKey: key, memberLevel: lvl };
    pushSubjectWithAccounts(out, col, sk, ctx);
  }
}

// Emit one aggregate "count" column and map every folded subject to it.
function emitAggregateColumn(out, userToAgg, members, info) {
  const { u, key, lvl, nAttr } = info;
  const aggId = `agg ${key}`;
  out.push({
    id: aggId, isAggregateCol: true, level: lvl,
    value: u.sortKeys?.[lvl] ?? '', childCounts: childCountsBelow(members, lvl, nAttr),
    userCount: members.length, sortKeys: aggregateSortKeys(u.sortKeys, lvl, nAttr, aggId),
    memberType: 'Aggregate', displayName: u.sortKeys?.[lvl] || '(none)',
  });
  for (const m of members) userToAgg.set(m.id, aggId);
}

// Emit the column(s) for a collapsed level — either its members (when
// member-expanded) or a single aggregate.
function emitCollapsedColumn(out, userToAgg, info, ctx) {
  const { users, key, lvl } = info;
  const members = users.filter(x => collapseKey(x.sortKeys, lvl) === key);
  const memMode = ctx.memberExpanded.get(key);
  if (memMode) emitMemberColumns(out, members, { ...info, memMode }, ctx);
  else emitAggregateColumn(out, userToAgg, members, info);
}

// Build the rendered subject columns: identity/principal subjects with per-account
// sub-columns spliced in after any expanded identity, AND collapsed attribute
// groups replaced by a single aggregate (or member-expanded) column. Analytics
// stay keyed on the identity-only `users`; only rendering uses these sets.
export function buildColumns(users, ctx) {
  const { collapsedGroups, sortAttrs } = ctx;
  const nAttr = sortAttrs.length;
  const out = [];
  const userToAgg = new Map();
  const emitted = new Set();
  for (const u of users) {
    const lvl = shallowestCollapsedLevel(u.sortKeys, nAttr, collapsedGroups);
    if (lvl < 0) {
      pushSubjectWithAccounts(out, u, u.sortKeys, ctx);
      continue;
    }
    const key = collapseKey(u.sortKeys, lvl);
    if (emitted.has(key)) continue;
    emitted.add(key);
    emitCollapsedColumn(out, userToAgg, { users, u, key, lvl, nAttr }, ctx);
  }
  return { cols: out, userToAgg };
}
