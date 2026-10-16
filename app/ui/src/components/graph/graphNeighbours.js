// ─── Relationship graph: the neighbours of one object ─────────────────
// neighbours(kind, id) → [relation] on top of what entityGraphShape.js already
// knows per entity kind (the categories, their counts, their fetchers) and what
// the organisation lists say about the object (orgGraphBranch.js). Each category
// is one relation; this module only adds what an EDGE needs: its label and its
// direction. See graphModel.js for the relation shape.
//
// Labels read from → to: "Dana —member of→ GRP-Sales", "Dana —reports to→ Ann".
// The same relation seen from either end gets the same label and direction, so
// the two expansions draw one edge. Recently Added / Removed are time views,
// not relations, and stay out of the graph.
import {
  getRootNodes,
  fetchCategoryItems,
  fetchEntityCore,
  extrasFromCore,
  isExpandableItem,
} from '@ui/components/entityGraphShape';
import { CLUSTER_THRESHOLD } from './graphModel';
import { loadOrgLinked, orgLinkedUrl, orgRelations } from '@ui/components/orgtruth/orgGraphBranch';

// categoryKey → [edge label, direction] per entity kind.
const RELATIONS = {
  user: {
    manager: ['reports to', 'out'],
    reports: ['reports to', 'in'],
    contexts: ['in context', 'out'],
    'assignments-direct': ['member of', 'out'],
    'assignments-indirect': ['indirect member of', 'out'],
    'assignments-eligible': ['eligible', 'out'],
    'access-packages': ['member of', 'out'],
    identity: ['linked account', 'in'],
    'linked-resource': ['linked resource', 'out'],
    owners: ['owner', 'in'],
    sponsors: ['sponsor', 'in'],
    'owned-agents': ['owner', 'out'],
    'sponsored-guests': ['sponsor', 'out'],
  },
  resource: {
    'members-direct': ['member of', 'in'],
    'members-indirect': ['indirect member of', 'in'],
    'members-eligible': ['eligible', 'in'],
    'business-roles': ['contains', 'in'],
    parents: ['member of', 'out'],
    contexts: ['in context', 'out'],
  },
  'access-package': {
    assignments: ['member of', 'in'],
    resources: ['contains', 'out'],
    catalog: ['in catalog', 'out'],
  },
  identity: {
    accounts: ['linked account', 'out'],
    contexts: ['in context', 'out'],
  },
  context: {
    members: ['in context', 'in'],
    subcontexts: ['sub-context of', 'in'],
  },
};

// An organisation entity's rings: its own relations by predicate, and its links
// to system objects. A link seen from this side says only "linked"; the system
// object's side knows the attribute it matched on, which then wins (generic).
function orgEntityRelation(categoryKey) {
  const rel = /^rel:(out|in):(.+)$/s.exec(categoryKey);
  if (rel) return { label: rel[2], dir: rel[1] };
  if (categoryKey.startsWith('link:')) return { label: 'linked', dir: 'in', generic: true };
  return null;
}

export function relationOf(entityKind, category) {
  if (entityKind === 'org-entity') {
    const org = orgEntityRelation(category.key);
    if (org) return org;
  }
  const known = RELATIONS[entityKind]?.[category.key];
  if (known) return { label: known[0], dir: known[1] };
  return { label: String(category.label || category.key).toLowerCase(), dir: 'out' };
}

// Holding a GroupOwnership (or any *Ownership) resource is owning the thing.
export function itemEdgeLabel(relationLabel, item) {
  return relationLabel === 'member of' && /Ownership$/.test(item.resourceType || '') ? 'owner' : relationLabel;
}

export function categoryRelations(entityKind, categories) {
  return categories
    .filter(c => (Number(c.count) || 0) > 0 && !c.key.startsWith('recently-'))
    .map(c => ({
      key: c.key,
      categoryKey: c.key,
      title: c.label,
      count: Number(c.count),
      items: null,
      ...relationOf(entityKind, c),
    }));
}

function withEdgeLabels(relation, items) {
  return items.map(item => ({ ...item, edgeLabel: item.edgeLabel || itemEdgeLabel(relation.label, item) }));
}

/** The objects of one relation: already loaded, or fetched through entityGraphShape. */
export async function relationItems(source, relation, authFetch) {
  if (relation.items) return relation.items;
  const items = await fetchCategoryItems(source.kind, source.id, relation.categoryKey, authFetch, source.extras || {});
  return withEdgeLabels(relation, items);
}

// A relation whose objects fail to load stays a cluster (count known, objects
// not), so one broken endpoint does not cost the object its other relations.
async function preload(source, relation, authFetch) {
  try {
    return { ...relation, items: await relationItems(source, relation, authFetch) };
  } catch {
    return relation;
  }
}

async function organisationRelations(kind, id, authFetch, orgTruth) {
  const url = orgTruth ? orgLinkedUrl(kind, id) : null;
  if (!url) return [];
  return orgRelations(await loadOrgLinked(url, authFetch));
}

/**
 * source: { kind, id, core?, extras? } — the core is fetched when not given.
 * → { relations, extras } or null when the object cannot be loaded.
 * Small relations come with their objects; big ones stay unloaded until their
 * cluster is opened.
 */
export async function loadNeighbours(source, authFetch, { orgTruth = false } = {}) {
  if (!isExpandableItem(source.kind)) return null;
  const core = source.core || await fetchEntityCore(source.kind, source.id, authFetch);
  if (!core) return null;
  const extras = source.extras || extrasFromCore(source.kind, core);
  const full = { ...source, extras };
  const categories = categoryRelations(source.kind, getRootNodes(source.kind, core, extras));
  const loaded = await Promise.all(categories.map(r => (r.count <= CLUSTER_THRESHOLD ? preload(full, r, authFetch) : r)));
  const org = await organisationRelations(source.kind, source.id, authFetch, orgTruth);
  return { relations: [...loaded, ...org], extras };
}
