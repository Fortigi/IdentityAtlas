// ─── Organisation branch of the entity graph ─────────────────────────
// What the organisation lists say about one system object (a principal,
// identity, resource or context), as an "Organisation" root node on its detail
// page graph. The data is GET /api/org-truth/linked/:targetType/:id:
//
//   { total, groups: [{ key, entityType, via, kind, label, count, truncated,
//                       unlinkedRows?, sourceType?, items: [{ entityId, entityType, label, detail? }] }] }
//
// Rings: Organisation → one category node per group (key `org:<group.key>`) →
// that group's org entities as items (entityKind 'org-entity'). Everything is
// answered from the one payload loaded with the page (useOrgLinked), so no
// click here fetches. A missing payload (feature off, 404/501, error) means no
// node at all, so the rest of the graph never depends on this branch.

export const ORG_ROOT_KEY = 'org';
const GROUP_PREFIX = `${ORG_ROOT_KEY}:`;

// Graph entity kind → the targetType the endpoint takes. Kinds not listed
// (access-package, org-entity) get no Organisation node.
const TARGET_TYPE = {
  user: 'Principal',
  identity: 'Identity',
  resource: 'Resource',
  context: 'Context',
};

export function orgLinkedUrl(entityKind, entityId) {
  const targetType = TARGET_TYPE[entityKind];
  if (!targetType || !entityId) return null;
  return `/api/org-truth/linked/${targetType}/${encodeURIComponent(entityId)}`;
}

// Accept only a payload with a groups array; anything else reads as "no data".
export function asOrgLinked(payload) {
  return Array.isArray(payload?.groups) ? payload : null;
}

// The root node, or null when there is no payload. A zero total still shows
// the node, greyed like an empty Manager node: the lists were read, nothing
// in them points at this object.
export function orgRootNode(orgLinked) {
  if (!orgLinked) return null;
  return { key: ORG_ROOT_KEY, label: 'Organisation', count: Number(orgLinked.total) || 0, kind: 'category' };
}

export function isOrgCategory(categoryKey) {
  return categoryKey === ORG_ROOT_KEY || String(categoryKey).startsWith(GROUP_PREFIX);
}

function groupNode(group) {
  return { key: `${GROUP_PREFIX}${group.key}`, label: group.label, count: Number(group.count) || 0, kind: 'category' };
}

function itemNode(item) {
  const node = {
    key: `org-entity:${item.entityId}`,
    label: item.label || item.entityId || '(unknown)',
    kind: 'item',
    entityKind: 'org-entity',
    entityId: item.entityId,
  };
  if (item.entityType) node.resourceType = item.entityType;
  if (item.detail) node.detail = item.detail;
  return node;
}

// The note the list panel shows above a group's items: rows of a fact type
// that point at no other list, and a server-side cap.
export function groupNote(group) {
  const parts = [];
  const unlinked = Number(group.unlinkedRows) || 0;
  if (unlinked > 0) parts.push(`${unlinked} ${group.sourceType || 'other'} rows point at no ${group.entityType}`);
  if (group.truncated) parts.push(`showing the first ${group.items.length} of ${group.count}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// Items under an Organisation category, or null when the key is not one of
// ours. The returned array carries an optional `note` property for the list
// panel (the graph ring ignores it).
export function orgCategoryItems(categoryKey, orgLinked) {
  if (!isOrgCategory(categoryKey)) return null;
  const groups = orgLinked?.groups || [];
  if (categoryKey === ORG_ROOT_KEY) return groups.map(groupNode);
  const group = groups.find(g => `${GROUP_PREFIX}${g.key}` === categoryKey);
  if (!group) return [];
  const items = (group.items || []).map(itemNode);
  const note = groupNote({ ...group, items: group.items || [] });
  if (note) items.note = note;
  return items;
}
