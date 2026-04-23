// ─── entityGraphShape ────────────────────────────────────────────────
// Central description of the fanout graph: for every entity kind we
// care about (user, resource, access-package, identity, context), this
// module knows:
//
//   1. getRootNodes(core)        — the first-ring category nodes you
//                                  see when an entity is shown centered
//                                  in the graph. `core` is the payload
//                                  returned by fetchCore(...).
//
//   2. fetchCore(kind, id, authFetch)  — loads that entity's core
//                                  (attributes, counts) so getRootNodes
//                                  can be evaluated. Used when the user
//                                  drills into a satellite item and we
//                                  need to expand its own categories.
//
//   3. fetchItems(kind, id, categoryKey, authFetch, core)  — lists
//                                  the items under a given category
//                                  key. Used when the user clicks a
//                                  category node (root or fan-out) and
//                                  we show individual items as the
//                                  next ring.
//
// The detail pages drive expansion by storing a path of clicked nodes;
// each expansion step just asks this module what to fetch next.

// ─── Item shape ──────────────────────────────────────────────────────
// Items we fetch from the API come in many shapes (user rows, resource
// rows, AP rows, …). Each call site normalises them into a common node
// shape before handing them to the graph:
//
//   { key, label, kind: 'item', entityKind, entityId }
//
// So the caller can click an item node and recurse into getRootNodes
// for that entityKind. `kind: 'item'` suppresses the count badge in
// the graph and renders an initial letter instead.

const MAX_ITEMS_PER_FANOUT = 10;

function capItems(items, extraCountKey) {
  if (!items) return [];
  if (items.length <= MAX_ITEMS_PER_FANOUT) return items;
  const shown = items.slice(0, MAX_ITEMS_PER_FANOUT - 1);
  shown.push({
    key: '__overflow__',
    label: `+${items.length - (MAX_ITEMS_PER_FANOUT - 1)} more`,
    kind: 'item',
    overflow: true,
  });
  return shown;
}

// ─── User ────────────────────────────────────────────────────────────

function userRootNodes(core, identityInfo, manager) {
  const m = core.membershipByType || {};
  return [
    { key: 'manager',         label: 'Manager',           count: manager ? 1 : 0, kind: 'category' },
    { key: 'reports',         label: 'Direct Reports',    count: core.directReportCount || 0, kind: 'category' },
    // v6: a Principal can belong to many Contexts (one row in ContextMembers
    // per membership). The count comes from /api/user/:id (contextCount);
    // the items are loaded lazily via /api/user/:id/contexts.
    { key: 'contexts',        label: 'Contexts',          count: core.contextCount || 0, kind: 'category' },
    { key: 'groups-direct',   label: 'Groups (Direct)',   count: m.Direct || 0, kind: 'category' },
    { key: 'groups-indirect', label: 'Groups (Indirect)', count: m.Indirect || 0, kind: 'category' },
    { key: 'groups-owner',    label: 'Groups Owned',      count: m.Owner || 0, kind: 'category' },
    { key: 'groups-eligible', label: 'Eligible',          count: m.Eligible || 0, kind: 'category' },
    { key: 'access-packages', label: 'Access Packages',   count: core.accessPackageCount || 0, kind: 'category' },
    { key: 'oauth2-grants',   label: 'OAuth2 Grants',     count: core.oauth2GrantCount || 0, kind: 'category' },
    { key: 'identity',        label: 'Identity',          count: identityInfo?.identity ? 1 : 0, kind: 'category' },
  ];
}

// "Recently Added" / "Recently Removed" pseudo-categories prepended
// when the entity has a non-zero recent-changes bucket. The fanout
// items come from the cached recent-changes payload, not from a
// separate API call, so clicking the node is instant.
function recentRootNodes(recent) {
  if (!recent) return [];
  const out = [];
  if ((recent.addedCount || 0) > 0) {
    out.push({ key: 'recently-added',   label: 'Recently Added',   count: recent.addedCount,   kind: 'category', recent: 'added' });
  }
  if ((recent.removedCount || 0) > 0) {
    out.push({ key: 'recently-removed', label: 'Recently Removed', count: recent.removedCount, kind: 'category', recent: 'removed' });
  }
  return out;
}

async function fetchUserItems(userId, categoryKey, authFetch, extras = {}) {
  const { manager, identityInfo } = extras;
  const get = (p) => authFetch(p).then(r => r.ok ? r.json() : []);

  if (categoryKey === 'manager') {
    return manager ? [toItem(manager, 'user')] : [];
  }
  if (categoryKey === 'reports') {
    const d = await authFetch(`/api/org-chart/user/${encodeURIComponent(userId)}/reports`).then(r => r.ok ? r.json() : {});
    return (d.reports || []).map(r => toItem(r, 'user'));
  }
  if (categoryKey === 'contexts') {
    const rows = await get(`/api/user/${encodeURIComponent(userId)}/contexts`);
    return rows.map(c => toItem(c, 'context'));
  }
  if (categoryKey?.startsWith('groups-')) {
    const all = await get(`/api/user/${encodeURIComponent(userId)}/memberships`);
    const want = { 'groups-direct': 'Direct', 'groups-indirect': 'Indirect', 'groups-owner': 'Owner', 'groups-eligible': 'Eligible' }[categoryKey];
    return all.filter(m => m.membershipType === want).map(m => toItem({
      id: m.resourceId, displayName: m.resourceDisplayName || m.groupDisplayName,
    }, 'resource'));
  }
  if (categoryKey === 'access-packages') {
    const rows = await get(`/api/user/${encodeURIComponent(userId)}/access-packages`);
    return rows.map(ap => toItem({ id: ap.resourceId, displayName: ap.accessPackageName }, 'access-package'));
  }
  if (categoryKey === 'oauth2-grants') {
    const rows = await get(`/api/user/${encodeURIComponent(userId)}/oauth2-grants`);
    return rows.map(g => toItem({
      id: g.clientSpId, displayName: g.clientDisplayName || g.scopeDisplayName || 'OAuth2 grant',
    }, 'resource'));
  }
  if (categoryKey === 'identity') {
    return identityInfo?.identity ? [toItem(identityInfo.identity, 'identity')] : [];
  }
  return [];
}

// ─── Resource ────────────────────────────────────────────────────────

function resourceRootNodes(core) {
  const a = core.assignmentByType || {};
  return [
    { key: 'members-direct',   label: 'Direct Members', count: a.Direct || 0, kind: 'category' },
    { key: 'members-governed', label: 'Governed',        count: a.Governed || 0, kind: 'category' },
    { key: 'members-owner',    label: 'Owners',          count: a.Owner || 0, kind: 'category' },
    { key: 'members-eligible', label: 'Eligible',        count: a.Eligible || 0, kind: 'category' },
    { key: 'business-roles',   label: 'Business Roles',  count: core.accessPackageCount || 0, kind: 'category' },
    { key: 'parents',          label: 'Member Of',       count: core.parentResourceCount || 0, kind: 'category' },
    // v6: many-to-many context membership via ContextMembers, not a single
    // contextId column on Resources.
    { key: 'contexts',         label: 'Contexts',        count: core.contextCount || 0, kind: 'category' },
  ];
}

async function fetchResourceItems(resourceId, categoryKey, authFetch, _extras = {}) {
  const get = (p) => authFetch(p).then(r => r.ok ? r.json() : []);

  if (categoryKey?.startsWith('members-')) {
    const all = await get(`/api/resources/${encodeURIComponent(resourceId)}/assignments`);
    const want = { 'members-direct': 'Direct', 'members-governed': 'Governed', 'members-owner': 'Owner', 'members-eligible': 'Eligible' }[categoryKey];
    return all.filter(a => a.assignmentType === want).map(a => toItem({
      id: a.principalId, displayName: a.principalDisplayName,
    }, 'user'));
  }
  if (categoryKey === 'business-roles') {
    const rows = await get(`/api/resources/${encodeURIComponent(resourceId)}/business-roles`);
    return rows.map(r => toItem({
      id: r.businessRoleId, displayName: r.businessRoleName || 'Unnamed',
    }, 'access-package'));
  }
  if (categoryKey === 'parents') {
    const rows = await get(`/api/resources/${encodeURIComponent(resourceId)}/parent-resources`);
    return rows.map(p => toItem({
      id: p.parentResourceId, displayName: p.parentDisplayName,
    }, p.parentResourceType === 'BusinessRole' ? 'access-package' : 'resource'));
  }
  if (categoryKey === 'contexts') {
    const rows = await get(`/api/resources/${encodeURIComponent(resourceId)}/contexts`);
    return rows.map(c => toItem(c, 'context'));
  }
  return [];
}

// ─── Access Package (Business Role) ──────────────────────────────────

function accessPackageRootNodes(core) {
  const a = core.attributes || {};
  return [
    { key: 'assignments', label: 'Assignments',      count: +core.assignmentCount || 0,    kind: 'category' },
    { key: 'resources',   label: 'Resources',        count: +core.groupCount || 0,         kind: 'category' },
    { key: 'policies',    label: 'Policies',         count: +core.policyCount || 0,        kind: 'category' },
    { key: 'reviews',     label: 'Reviews',          count: +core.reviewCount || 0,        kind: 'category' },
    { key: 'requests',    label: 'Pending Requests', count: +core.pendingRequestCount || 0, kind: 'category' },
    { key: 'catalog',     label: 'Catalog',          count: a.catalogId ? 1 : 0,           kind: 'category' },
  ];
}

async function fetchAccessPackageItems(apId, categoryKey, authFetch, extras = {}) {
  const { catalogId, catalogName } = extras;
  const get = (p) => authFetch(p).then(r => r.ok ? r.json() : []);

  if (categoryKey === 'assignments') {
    const rows = await get(`/api/access-package/${encodeURIComponent(apId)}/assignments`);
    return rows.map(a => toItem({ id: a.principalId, displayName: a.targetDisplayName }, 'user'));
  }
  if (categoryKey === 'resources') {
    const rows = await get(`/api/access-package/${encodeURIComponent(apId)}/resource-roles`);
    return rows.map(r => toItem({
      id: r.childResourceId,
      displayName: r.resourceDisplayName || r.scopeDisplayName || r.groupDisplayName || r.roleName,
    }, 'resource'));
  }
  if (categoryKey === 'policies') {
    const rows = await get(`/api/access-package/${encodeURIComponent(apId)}/policies`);
    // Policies don't have a detail page to drill into, show them as leaves.
    return rows.map(p => toItem({ id: p.id, displayName: p.displayName || 'Policy' }, 'leaf'));
  }
  if (categoryKey === 'reviews') {
    const rows = await get(`/api/access-package/${encodeURIComponent(apId)}/reviews`);
    return rows.map(r => toItem({
      id: r.id, displayName: r.principalDisplayName || 'Review',
    }, 'leaf'));
  }
  if (categoryKey === 'requests') {
    const rows = await get(`/api/access-package/${encodeURIComponent(apId)}/requests`);
    return rows.map(r => toItem({
      id: r.id, displayName: r.requestorDisplayName || 'Request',
    }, 'leaf'));
  }
  if (categoryKey === 'catalog') {
    if (!catalogId) return [];
    return [toItem({ id: catalogId, displayName: catalogName || catalogId }, 'leaf')];
  }
  return [];
}

// ─── Identity ────────────────────────────────────────────────────────

function identityRootNodes(core) {
  const agg = core.aggregateAssignments || {};
  return [
    { key: 'accounts',        label: 'Linked Accounts', count: (core.members || []).length, kind: 'category' },
    { key: 'contexts',        label: 'Contexts',        count: core.contextCount || 0, kind: 'category' },
    { key: 'groups-direct',   label: 'Groups (Direct)', count: agg.Direct || 0, kind: 'category' },
    { key: 'groups-governed', label: 'Governed',        count: agg.Governed || 0, kind: 'category' },
    { key: 'groups-owner',    label: 'Owned',           count: agg.Owner || 0, kind: 'category' },
    { key: 'groups-eligible', label: 'Eligible',        count: agg.Eligible || 0, kind: 'category' },
    { key: 'oauth2-grants',   label: 'OAuth2 Grants',   count: agg.OAuth2Grant || 0, kind: 'category' },
  ];
}

async function fetchIdentityItems(identityId, categoryKey, authFetch, extras = {}) {
  const { members } = extras;
  if (categoryKey === 'accounts') {
    return (members || []).map(m => toItem({ id: m.principalId, displayName: m.displayName }, 'user'));
  }
  if (categoryKey === 'contexts') {
    const rows = await authFetch(`/api/identities/${encodeURIComponent(identityId)}/contexts`)
      .then(r => r.ok ? r.json() : []);
    return rows.map(c => toItem(c, 'context'));
  }
  const typeMap = {
    'groups-direct':   'Direct',
    'groups-governed': 'Governed',
    'groups-owner':    'Owner',
    'groups-eligible': 'Eligible',
    'oauth2-grants':   'OAuth2Grant',
  };
  if (typeMap[categoryKey]) {
    const rows = await authFetch(`/api/identities/${encodeURIComponent(identityId)}/assignments?type=${typeMap[categoryKey]}`)
      .then(r => r.ok ? r.json() : []);
    return rows.map(r => toItem({
      id: r.resourceId, displayName: r.resourceDisplayName,
    }, r.resourceType === 'BusinessRole' ? 'access-package' : 'resource'));
  }
  return [];
}

// ─── Context ─────────────────────────────────────────────────────────

function contextRootNodes(core) {
  const members = core.members || [];
  const subs = core.subContexts || [];
  return [
    { key: 'members',     label: 'Members',     count: members.length, kind: 'category' },
    { key: 'subcontexts', label: 'Sub-contexts', count: subs.length,   kind: 'category' },
  ];
}

async function fetchContextItems(_contextId, categoryKey, _authFetch, extras = {}) {
  const { members, subContexts } = extras;
  if (categoryKey === 'members') {
    return (members || []).map(m => toItem({ id: m.id, displayName: m.displayName }, 'user'));
  }
  if (categoryKey === 'subcontexts') {
    return (subContexts || []).map(s => toItem({ id: s.id, displayName: s.displayName }, 'context'));
  }
  return [];
}

// ─── Public API ──────────────────────────────────────────────────────

function toItem(row, entityKind) {
  const id = row?.id || '';
  return {
    key: `${entityKind}:${id}`,
    label: row?.displayName || id || '(unknown)',
    kind: 'item',
    entityKind,
    entityId: id,
  };
}

export function getRootNodes(entityKind, core, extras = {}) {
  let base;
  switch (entityKind) {
    case 'user':           base = userRootNodes(core, extras.identityInfo, extras.manager); break;
    case 'resource':       base = resourceRootNodes(core); break;
    case 'access-package': base = accessPackageRootNodes(core); break;
    case 'identity':       base = identityRootNodes(core); break;
    case 'context':        base = contextRootNodes(core); break;
    default:               return [];
  }
  // Recent-change pseudo-categories go first so they read as "see this
  // first when something just moved" rather than buried at the end.
  return [...recentRootNodes(extras.recent), ...base];
}

export async function fetchCategoryItems(entityKind, entityId, categoryKey, authFetch, extras = {}) {
  // Recently-added / Recently-removed don't hit an endpoint — we already
  // have the events on the root entity's recent-changes bundle. Each
  // event's counterparty becomes a satellite tagged with its recency
  // state so the graph colours them accordingly.
  if (categoryKey === 'recently-added' || categoryKey === 'recently-removed') {
    const bucket = extras.recent?.[categoryKey === 'recently-added' ? 'added' : 'removed'] || [];
    const items = bucket.map(evt => ({
      key: `${evt.counterpartyKind || 'leaf'}:${evt.counterpartyId || evt.at}`,
      label: evt.counterpartyLabel || evt.summary,
      kind: 'item',
      entityKind: evt.counterpartyKind || 'leaf',
      entityId: evt.counterpartyId,
      recent: categoryKey === 'recently-added' ? 'added' : 'removed',
    }));
    return capItems(items);
  }

  let items = [];
  switch (entityKind) {
    case 'user':           items = await fetchUserItems(entityId, categoryKey, authFetch, extras); break;
    case 'resource':       items = await fetchResourceItems(entityId, categoryKey, authFetch, extras); break;
    case 'access-package': items = await fetchAccessPackageItems(entityId, categoryKey, authFetch, extras); break;
    case 'identity':       items = await fetchIdentityItems(entityId, categoryKey, authFetch, extras); break;
    case 'context':        items = await fetchContextItems(entityId, categoryKey, authFetch, extras); break;
  }
  // Tag items that were added inside the recent window so the graph can
  // highlight them inside regular fanouts too.
  const addedIds = extras.recent?.addedIds;
  if (addedIds && addedIds.size > 0 && items.length > 0) {
    items = items.map(it => addedIds.has(it.entityId) ? { ...it, recent: 'added' } : it);
  }
  return capItems(items);
}

// Fetch the core payload for any entity kind — used when drilling into a
// non-root item so we can call getRootNodes on it.
export async function fetchEntityCore(entityKind, entityId, authFetch) {
  const url = {
    'user':           `/api/user/${encodeURIComponent(entityId)}`,
    'resource':       `/api/resources/${encodeURIComponent(entityId)}`,
    'access-package': `/api/access-package/${encodeURIComponent(entityId)}`,
    'identity':       `/api/identities/${encodeURIComponent(entityId)}`,
    'context':        `/api/contexts/${encodeURIComponent(entityId)}`,
  }[entityKind];
  if (!url) return null;
  const r = await authFetch(url);
  if (!r.ok) return null;
  return r.json();
}

// Some item kinds (leaf, policy row, review row) can't expand further —
// the graph should just open the detail tab on click or do nothing.
export function isExpandableItem(entityKind) {
  return ['user', 'resource', 'access-package', 'identity', 'context'].includes(entityKind);
}

// Pull the extras the fetchers need from a freshly-loaded core payload.
// Called after drilling into an item so we can populate the secondary
// fanouts without re-fetching the same endpoints.
export function extrasFromCore(entityKind, core) {
  if (!core) return {};
  // v6: Principals/Identities/Resources don't carry a contextId column any
  // more; the contexts category fetches its list lazily via the dedicated
  // endpoint, so no per-core extras are needed here for it.
  switch (entityKind) {
    case 'access-package':
      return { catalogId: core.attributes?.catalogId, catalogName: core.attributes?.catalogName };
    case 'identity':
      return { members: core.members };
    case 'context':
      return { members: core.members, subContexts: core.subContexts };
    default:
      return {};
  }
}
