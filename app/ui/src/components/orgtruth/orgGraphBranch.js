// ─── Organisation relations in the entity graph ──────────────────────
// What the organisation lists say about one system object (a principal,
// identity, resource or context), as relations of that object in the
// relationship graph (components/graph). The data is
// GET /api/org-truth/linked/:targetType/:id:
//
//   { total, groups: [{ key, entityType, via, kind, label, count, truncated,
//                       unlinkedRows?, sourceType?, items: [{ entityId, entityType, label, detail?, hours? }] }] }
//
// Each group is one relation, and the org entity is a DIRECT neighbour of the
// object: the group PortOfRotterdam gets one edge "name" to the node
// "Klant · PortOfRotterdam", not an Organisation bucket and a "Klant · name"
// bucket in between. A direct group's edge is labelled with the attribute that
// linked them (`eigenaar`, `team`, `name` for the display name); a through group
// (timesheet rows about the object, pointing at a customer) with what the rows
// add up to: "worked on · 1,491 h (Uren)".
//
// A missing payload (feature off, 404/501, error) means no relations, so the
// rest of the graph never depends on this.

// Graph entity kind → the targetType the endpoint takes. Kinds not listed
// (access-package, org-entity) have no organisation relations.
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

// Answers are cached per url and authFetch (a sign-in change starts fresh); a
// failure is not cached, the next expansion asks again.
const cache = new WeakMap();

export function loadOrgLinked(url, authFetch) {
  let byUrl = cache.get(authFetch);
  if (!byUrl) {
    byUrl = new Map();
    cache.set(authFetch, byUrl);
  }
  if (!byUrl.has(url)) {
    const pending = Promise.resolve()
      .then(() => authFetch(url))
      .then(r => (r.ok ? r.json() : null))
      .then(asOrgLinked)
      .catch(() => null)
      .then((data) => {
        if (!data) byUrl.delete(url);
        return data;
      });
    byUrl.set(url, pending);
  }
  return byUrl.get(url);
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

export const viaLabel = (via) => (!via || via === 'displayName' ? 'name' : via);

const hours = (h) => Number(h).toLocaleString('en-US', { maximumFractionDigits: 1 });

function throughLabel(group, item) {
  const source = group.sourceType || 'other';
  return item.hours == null ? `worked on (${source})` : `worked on · ${hours(item.hours)} h (${source})`;
}

function orgItem(item, edgeLabel) {
  const node = {
    key: `org-entity:${item.entityId}`,
    label: item.label || item.entityId || '(unknown)',
    kind: 'item',
    entityKind: 'org-entity',
    entityId: item.entityId,
  };
  if (item.entityType) node.resourceType = item.entityType;
  if (item.detail) node.detail = item.detail;
  if (edgeLabel) node.edgeLabel = edgeLabel;
  return node;
}

const groupLabel = (group) => (group.kind === 'through' ? `worked on (${group.sourceType || 'other'})` : viaLabel(group.via));
const itemLabel = (group, item) => (group.kind === 'through' ? throughLabel(group, item) : viaLabel(group.via));
const MAX_RELATION_LABELS = 3;

function joinLabels(labels) {
  const shown = labels.slice(0, MAX_RELATION_LABELS).join(' · ');
  return labels.length > MAX_RELATION_LABELS ? `${shown} …` : shown;
}

// One relation per entity TYPE, however many attributes linked it: a person who
// owns 14 customers, is on the team of 3 and wrote hours on 4 gets ONE "Klant"
// relation (a cluster with the count, like business roles or memberships), not
// three fans of customer nodes. Each customer, once the cluster is opened, gets
// one edge that lists every way it is linked ("eigenaar · worked on · 120 h (Uren)").
function typeRelation(entityType, groups) {
  const byEntity = new Map();
  for (const group of groups) {
    for (const item of group.items || []) {
      const seen = byEntity.get(item.entityId) ?? { item, labels: [] };
      seen.labels.push(itemLabel(group, item));
      byEntity.set(item.entityId, seen);
    }
  }
  const items = [...byEntity.values()].map(({ item, labels }) => orgItem(item, labels.join(' · ')));
  const truncated = groups.some(g => g.truncated);
  const relation = {
    key: `org:type:${entityType}`,
    title: entityType,
    label: joinLabels([...new Set(groups.map(groupLabel))]),
    dir: 'out',
    count: truncated ? Math.max(items.length, ...groups.map(g => Number(g.count) || 0)) : items.length,
    items,
    cluster: items.length > 1,
  };
  const notes = groups.map(g => groupNote({ ...g, items: g.items || [] })).filter(Boolean);
  if (notes.length > 0) relation.note = notes.join(' · ');
  return relation;
}

/** The organisation payload → graph relations, one per entity type (see graphModel.js); [] without one. */
export function orgRelations(orgLinked) {
  const byType = new Map();
  for (const group of orgLinked?.groups || []) {
    const type = group.entityType || 'Organisation';
    byType.set(type, [...(byType.get(type) ?? []), group]);
  }
  return [...byType.entries()].map(([type, groups]) => typeRelation(type, groups));
}
