// Organisation truth — the projection, as a pure function plus the plugin
// factory both registered plugins are made from (plugin.js = Resource members,
// pluginPrincipals.js = Principal members).
//
// Tree, per plugin run:
//   org:root                 "Organisation truth"          contextType OrganisationTruth
//     org:type:<entityType>  one per projected type        contextType OrganisationEntityType
//       org:<entityId>       one per open, accepted entity contextType = the entity type
//
// Which types are projected: `params.entityTypes` when it is a non-empty list;
// otherwise every type with an entity that has an accepted link (to any target
// type) or is one accepted relation away from an entity that has one.
// Within a projected type every open, accepted entity appears, linked or not —
// an unlinked project is a finding, not noise.
//
// Members of an entity context: the targets of its own accepted links whose
// target type is the plugin's member type, plus those of every entity it is
// related to by an accepted, open relation (either direction, one hop — not
// transitive). For Principal members an Identity link counts through that
// identity's accounts. Nothing here reads a proposed, rejected or closed row:
// projectionSql.js never returns one.
//
// Decision (T4): a type named in `entityTypes` that has no open, accepted
// entity yields no type node, so the tree never shows an empty branch for a
// typo. With nothing to project the run emits nothing (no lone root), and the
// runner removes a previous tree.
import { loadProjectionInput } from './projectionSql.js';

export const ROOT_EXTERNAL_ID = 'org:root';
export const typeExternalId = (entityType) => `org:type:${entityType}`;
export const entityExternalId = (entityId) => `org:${entityId}`;

// An accepted claim that no full run has closed.
export function isLive(row) {
  return row.status === 'accepted' && row.validTo == null;
}

function isLiveLink(link) {
  return link.status === 'accepted' && link.analystOverride !== 'rejected';
}

// The member ids one link row contributes for a given member type.
export function linkMemberId(link, memberType) {
  if (link.targetType === memberType) return link.targetId;
  if (memberType !== 'Principal' || link.targetType !== 'Identity') return null;
  if (link.memberOverride === 'rejected') return null;
  return link.principalId || null;
}

function addTo(map, key, value) {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(value);
}

function directMembers(links, memberType) {
  const byEntity = new Map();
  for (const link of links) {
    const memberId = linkMemberId(link, memberType);
    if (memberId) addTo(byEntity, link.entityId, memberId);
  }
  return byEntity;
}

function neighbours(relations, entityIds) {
  const byEntity = new Map();
  for (const r of relations) {
    if (!entityIds.has(r.fromEntityId) || !entityIds.has(r.toEntityId)) continue;
    addTo(byEntity, r.fromEntityId, r.toEntityId);
    addTo(byEntity, r.toEntityId, r.fromEntityId);
  }
  return byEntity;
}

// Default scope: the types that are THINGS WITH SYSTEM OBJECTS ATTACHED — a
// customer with its owner, team and group. An entity counts when it (or an
// entity one relation away) has an accepted link to a Resource or Context, or
// to an account/person THROUGH AN ATTRIBUTE (owner, team), or when an entity of
// another list links to it (the customer a timesheet row names).
// Not projected by default: a list whose rows ARE people (linked to their own
// account through their name) and a fact list (timesheet rows, which only link
// to accounts by name and to other lists' entities) — one context per row of
// those is noise, not a scope.
const PERSON_TARGETS = new Set(['Principal', 'Identity']);
const isScopeLink = (l) => l.targetType === 'Resource' || l.targetType === 'Context'
  || (PERSON_TARGETS.has(l.targetType) && l.via && l.via !== 'displayName');

export function projectedTypes(entities, links, entityTypes, related = new Map()) {
  const present = new Set(entities.map(e => e.entityType));
  let wanted;
  if (Array.isArray(entityTypes) && entityTypes.length > 0) {
    wanted = new Set(entityTypes);
  } else {
    const scoped = new Set(links.filter(isScopeLink).map(l => l.entityId));
    // referenced THROUGH AN ATTRIBUTE (the timesheet's customer column), not a
    // row that is the same person as another list's row
    for (const l of links) if (l.targetType === 'OrgEntity' && l.via && l.via !== 'displayName') scoped.add(l.targetId);
    const reaches = (e) => scoped.has(e.id) || [...(related.get(e.id) || [])].some(id => scoped.has(id));
    wanted = new Set(entities.filter(reaches).map(e => e.entityType));
  }
  return [...present].filter(t => wanted.has(t)).sort();
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}

function entityContext(entity) {
  const attributes = entity.attributes && typeof entity.attributes === 'object' && !Array.isArray(entity.attributes)
    ? entity.attributes : {};
  return {
    externalId: entityExternalId(entity.id),
    displayName: entity.displayName,
    contextType: entity.entityType,
    parentExternalId: typeExternalId(entity.entityType),
    extendedAttributes: {
      ...attributes,
      orgEntityId: entity.id,
      sourceId: entity.sourceId,
      observedAt: toIso(entity.observedAt),
    },
  };
}

function typeContext(entityType) {
  return {
    externalId: typeExternalId(entityType),
    displayName: entityType,
    contextType: 'OrganisationEntityType',
    description: `Organisation entities of type ${entityType}`,
    parentExternalId: ROOT_EXTERNAL_ID,
  };
}

const ROOT_CONTEXT = {
  externalId: ROOT_EXTERNAL_ID,
  displayName: 'Organisation truth',
  contextType: 'OrganisationTruth',
  description: 'Entities from the organisation lists, with the system objects linked to them',
};

function membersOf(entityId, direct, related) {
  const ids = new Set(direct.get(entityId) || []);
  for (const other of related.get(entityId) || []) {
    for (const id of direct.get(other) || []) ids.add(id);
  }
  return ids;
}

/**
 * @param {{entities: object[], relations: object[], links: object[]}} input
 * @param {{memberType: 'Resource'|'Principal', entityTypes?: string[]}} opts
 * @returns {{contexts: object[], members: {contextExternalId: string, memberId: string}[]}}
 */
export function buildProjection(input, { memberType, entityTypes }) {
  const entities = input.entities.filter(isLive);
  const entityIds = new Set(entities.map(e => e.id));
  const relations = input.relations.filter(isLive);
  const links = input.links.filter(l => isLiveLink(l) && entityIds.has(l.entityId));
  const related = neighbours(relations, entityIds);
  const types = projectedTypes(entities, links, entityTypes, related);
  if (types.length === 0) return { contexts: [], members: [] };

  const typeSet = new Set(types);
  const projected = entities.filter(e => typeSet.has(e.entityType));
  const direct = directMembers(links, memberType);

  const contexts = [ROOT_CONTEXT, ...types.map(typeContext), ...projected.map(entityContext)];
  const members = [];
  for (const entity of projected) {
    const contextExternalId = entityExternalId(entity.id);
    for (const memberId of membersOf(entity.id, direct, related)) members.push({ contextExternalId, memberId });
  }
  return { contexts, members };
}

export function makeOrgTruthPlugin({ name, displayName, description, targetType }) {
  return {
    name,
    displayName,
    description,
    targetType,
    parametersSchema: {
      type: 'object',
      properties: {
        entityTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Organisation entity types to project; empty = every type that has accepted links.',
        },
      },
    },
    async run(params, ctx) {
      const input = await loadProjectionInput();
      const result = buildProjection(input, { memberType: targetType, entityTypes: params?.entityTypes });
      ctx?.log?.(`${name}: ${result.contexts.length} context(s), ${result.members.length} member link(s).`);
      return result;
    },
  };
}
