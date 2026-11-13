// Context upload — the ingest records an upload writes.
//
// Pure. The units (plan.js) become, per tree, synced contexts owned by the list's
// system; their matched members become context-members records; Responsibles and
// SameUnitAs links become the row shape the add-only context-links ingest takes.
//
// One tree per member kind of the list (at most two); a list without member
// columns gets one tree of the template's natural kind. Context ids are the
// ingest's own deterministic GUIDs, namespaced per (list, tree): the same key in
// the same list gets the same id on every upload, so a re-import updates in
// place, and the two trees of one list never collide.

import { deterministicGuid } from '../../ingest/normalization.js';
import { ROOT_KEY } from './plan.js';

const CONTEXT_TYPE = { OrganizationalUnit: 'OrgUnit', LogicalApplication: 'LogicalApplication' };
const DEFAULT_KIND = { OrganizationalUnit: 'Identity', LogicalApplication: 'Resource' };
export const KIND_LABEL = { Identity: 'People', Principal: 'Accounts', Resource: 'Resources' };

/** The trees of a list, primary first: its member kinds in mapping order, or the template's default. */
export function treeKinds(mapping) {
  const kinds = [...new Set(mapping.memberColumns.map(m => m.kind))];
  return kinds.length ? kinds : [DEFAULT_KIND[mapping.template]];
}

/** The id of the context for `key` in the list's tree of `kind`. */
export function contextIdFor(systemId, kind, key) {
  return deterministicGuid(`upload-${systemId}-${kind}`, key);
}

/** The root's display name: the list name, plus the kind for the second tree. */
export function rootName(listName, kind, index) {
  return index === 0 ? listName : `${listName} · ${KIND_LABEL[kind]}`;
}

function contextRecord({ id, key, name, parentId, kind, mapping, systemId, owner = null, attributes = null }) {
  return {
    id,
    externalId: key,
    displayName: name.slice(0, 500),
    variant: 'synced',
    targetType: kind,
    contextType: CONTEXT_TYPE[mapping.template],
    scopeSystemId: systemId,
    parentContextId: parentId,
    ownerUserId: owner,
    extendedAttributes: attributes && Object.keys(attributes).length ? attributes : null,
  };
}

/** Every context of every tree: each tree's root, then its units (parent before child is not required). */
export function buildContextRecords(units, mapping, systemId) {
  const records = [];
  treeKinds(mapping).forEach((kind, i) => {
    const rootId = contextIdFor(systemId, kind, ROOT_KEY);
    records.push(contextRecord({ id: rootId, key: ROOT_KEY, name: rootName(mapping.listName, kind, i), parentId: null, kind, mapping, systemId }));
    for (const u of units) {
      const parentId = u.parentKey ? contextIdFor(systemId, kind, u.parentKey) : rootId;
      records.push(contextRecord({
        id: contextIdFor(systemId, kind, u.key), key: u.key, name: u.name, parentId, kind, mapping, systemId,
        owner: u.owner, attributes: u.attributes,
      }));
    }
  });
  return records;
}

/**
 * A context of the list that the file no longer has, as a record that writes it
 * back unchanged — so a full-sync batch keeps it (the analyst chose to keep
 * contexts that are not in the file).
 */
export function keptRecord(row, systemId) {
  return {
    id: row.id,
    externalId: row.externalId,
    displayName: row.displayName,
    variant: 'synced',
    targetType: row.targetType,
    contextType: row.contextType,
    scopeSystemId: systemId,
    parentContextId: row.parentContextId ?? null,
    ownerUserId: row.ownerUserId ?? null,
    extendedAttributes: row.extendedAttributes ?? null,
  };
}

/** The distinct member values per kind, for matching. */
export function memberValues(units) {
  const out = {};
  for (const u of units) {
    for (const [kind, values] of Object.entries(u.members)) {
      out[kind] ??= new Set();
      values.forEach(v => out[kind].add(v));
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, s]) => [k, [...s]]));
}

/** context-members records for every matched value, deduplicated. */
export function buildMemberRecords(units, mapping, systemId, ids) {
  const seen = new Set();
  const records = [];
  for (const kind of treeKinds(mapping)) {
    const matched = ids[kind] ?? new Map();
    for (const u of units) {
      const contextId = contextIdFor(systemId, kind, u.key);
      for (const value of u.members[kind] ?? []) {
        const memberId = matched.get(value);
        if (!memberId || seen.has(`${contextId}|${memberId}`)) continue;
        seen.add(`${contextId}|${memberId}`);
        records.push({ contextId, memberId, memberType: kind, addedBy: 'sync' });
      }
    }
  }
  return records;
}

// Role rows (contextLinks.js shape) for every tree: per unit, the values
// `valuesOf(unit)` names that matched an account.
function roleRows(units, mapping, systemId, accountIds, role, valuesOf) {
  const rows = [];
  for (const kind of treeKinds(mapping)) {
    for (const u of units) {
      for (const value of valuesOf(u)) {
        const holderId = accountIds.get(value);
        if (holderId) rows.push({ contextId: contextIdFor(systemId, kind, u.key), role, holderCol: 'principalId', holderId });
      }
    }
  }
  return rows;
}

/** Responsible role rows for every tree, from matched accounts. */
export const buildResponsibleRows = (units, mapping, systemId, accountIds) =>
  roleRows(units, mapping, systemId, accountIds, 'Responsible', u => u.responsibles);

/** Accountable role rows for every tree: each unit's owner, when it matched an account. */
export const buildOwnerRows = (units, mapping, systemId, accountIds) =>
  roleRows(units, mapping, systemId, accountIds, 'Accountable', u => (u.owner ? [u.owner] : []));

/** SameUnitAs rows between the two trees of a list: the roots, and each key's pair. */
export function buildLinkRows(units, mapping, systemId) {
  const kinds = treeKinds(mapping);
  if (kinds.length < 2) return [];
  const [a, b] = kinds;
  return [ROOT_KEY, ...units.map(u => u.key)].map(key => ({
    contextId: contextIdFor(systemId, a, key),
    relatedContextId: contextIdFor(systemId, b, key),
    relationshipType: 'SameUnitAs',
  }));
}
