// Point-in-time snapshots for the entity-detail Diff tab — pure builders.
//
// The Diff tab compares an entity "as of" a past moment with the entity now.
// Both sides are expressed as the same snapshot shape:
//
//   { exists, deleted, attributes: { field: value }, relationships: [item] }
//   item = { key, group, label, kind, id, detail }
//
// The UI only ever diffs two snapshots, so a future "proposed state" can be
// fed in as the right-hand side without touching the diff view.
//
// How the past is rebuilt from `_history`: a history row stores the row's state
// BEFORE the change (`prevData`). So the state of a row at time T is the
// `prevData` of its FIRST change after T — or, when nothing changed since T, the
// row as it is now. A first change that is an INSERT means the row did not
// exist yet at T. This works even when history started after the initial load
// (migration 073 skips the initial load's inserts): an untouched row simply
// reads as unchanged.

import { TIMELINE_SKIP_FIELDS } from './timeline.js';

// Same bookkeeping columns the Timeline hides, plus the photo blob. managerId
// is shown as a relationship ("Manager"), deletedAt as the snapshot's
// `deleted` flag, and extendedAttributes is flattened into `ext.<name>` keys.
const SKIP_FIELDS = new Set([...TIMELINE_SKIP_FIELDS, 'photo', 'photoContentType', 'photoFetchedAt']);

export const EXT_PREFIX = 'ext.';

// A row counts as present when it exists and is not soft-deleted.
export function isPresent(row) {
  return !!row && !row.deletedAt;
}

// State of a row at time T, from its first history row after T (or none).
export function rowAt(firstAfter, current) {
  if (!firstAfter) return current ?? null;
  return firstAfter.operation === 'I' ? null : (firstAfter.prevData ?? null);
}

// Flatten an entity row into { field: value } for the attributes table.
export function attributeMap(row) {
  if (!row) return {};
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (SKIP_FIELDS.has(k)) continue;
    out[k] = v;
  }
  const ext = row.extendedAttributes;
  if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
    for (const [k, v] of Object.entries(ext)) out[`${EXT_PREFIX}${k}`] = v;
  }
  return out;
}

// ─── Relationship sources ─────────────────────────────────────────────
// Which relationship rows belong to an entity, per entity kind. `column` is
// the column of `table` that holds the viewed entity's id; `toItem` turns a
// row into a display item from the viewed entity's side.

const RESOURCE_TYPE_GROUPS = {
  BusinessRole: 'Business roles',
  Group: 'Groups',
  EntraDirectoryRole: 'Directory roles',
  Application: 'Applications',
  AppRole: 'App roles',
  DelegatedPermission: 'Delegated permissions',
  ApplicationPermission: 'Application permissions',
  GroupOwnership: 'Group ownership',
  ServicePrincipalOwnership: 'App ownership',
  ApplicationOwnership: 'App registration ownership',
};

export function resourceGroup(resourceType) {
  if (!resourceType) return 'Resources';
  return RESOURCE_TYPE_GROUPS[resourceType] || resourceType;
}

function resourceKind(resourceType) {
  return resourceType === 'BusinessRole' ? 'access-package' : 'resource';
}

function assignmentDetail(row) {
  return [row.assignmentType, row.governed ? 'governed' : null].filter(Boolean).join(' · ');
}

// The `_history` trigger keys composite-PK rows as `a|b|c` (migration 022);
// the same key identifies the row on both sides of the diff.
export function rowKey(table, row) {
  switch (table) {
    case 'ResourceAssignments': return `${row.resourceId}|${row.principalId}|${row.assignmentType}`;
    case 'ResourceRelationships': return `${row.parentResourceId}|${row.childResourceId}|${row.relationshipType}`;
    case 'IdentityMembers': return `${row.identityId}|${row.principalId}`;
    default: return String(row.id);
  }
}

const SOURCE = {
  heldResources: {
    name: 'heldResources', table: 'ResourceAssignments', column: 'principalId', softDelete: true,
    toItem: (row, lbl) => {
      const info = lbl.resource(row.resourceId);
      const type = row.resourceType || info?.resourceType;
      return { group: resourceGroup(type), label: info?.displayName || row.resourceId,
        kind: resourceKind(type), id: row.resourceId, detail: assignmentDetail(row) };
    },
  },
  members: {
    name: 'members', table: 'ResourceAssignments', column: 'resourceId', softDelete: true,
    toItem: (row, lbl) => ({ group: 'Members', label: lbl.principal(row.principalId) || row.principalId,
      kind: 'user', id: row.principalId, detail: assignmentDetail(row) }),
  },
  children: {
    name: 'children', table: 'ResourceRelationships', column: 'parentResourceId', softDelete: false,
    toItem: (row, lbl) => {
      const info = lbl.resource(row.childResourceId);
      return { group: 'Contains', label: info?.displayName || row.childResourceId,
        kind: resourceKind(info?.resourceType), id: row.childResourceId, detail: row.relationshipType };
    },
  },
  parents: {
    name: 'parents', table: 'ResourceRelationships', column: 'childResourceId', softDelete: false,
    toItem: (row, lbl) => {
      const info = lbl.resource(row.parentResourceId);
      return { group: 'Part of', label: info?.displayName || row.parentResourceId,
        kind: resourceKind(info?.resourceType), id: row.parentResourceId, detail: row.relationshipType };
    },
  },
  identity: {
    name: 'identity', table: 'IdentityMembers', column: 'principalId', softDelete: false,
    toItem: (row, lbl) => ({ group: 'Identity', label: lbl.identity(row.identityId) || row.identityId,
      kind: 'identity', id: row.identityId, detail: row.isPrimary ? 'primary account' : '' }),
  },
  accounts: {
    name: 'accounts', table: 'IdentityMembers', column: 'identityId', softDelete: false,
    toItem: (row, lbl) => ({ group: 'Linked accounts', label: lbl.principal(row.principalId) || row.displayName || row.principalId,
      kind: 'user', id: row.principalId, detail: row.isPrimary ? 'primary' : (row.accountType || '') }),
  },
};

// ContextMembers is not history-tracked, so a context has no relationship
// sources: its diff covers the context's own attributes only.
export const RELATIONSHIP_SOURCES = {
  user: [SOURCE.heldResources, SOURCE.identity],
  resource: [SOURCE.members, SOURCE.children, SOURCE.parents],
  'access-package': [SOURCE.members, SOURCE.children, SOURCE.parents],
  identity: [SOURCE.accounts],
  context: [],
};

export const ENTITY_TABLE = {
  user: 'Principals',
  resource: 'Resources',
  'access-package': 'Resources',
  identity: 'Identities',
  context: 'Contexts',
};

function toItem(source, row, lbl) {
  return { key: `${source.name}:${rowKey(source.table, row)}`, ...source.toItem(row, lbl) };
}

// Before/after items for one source.
//   changes:   [{ rowId, firstOp, firstPrev, lastOp, lastData }] — rows with
//              history after T (first and last change).
//   current:   rows present now (capped). Those not in `changes` are
//              unchanged, so they go on both sides.
//   total:     how many rows are present now (uncapped).
// Returns { before, after, omitted } — omitted = unchanged rows left out by
// the cap. Leaving an unchanged row out of BOTH sides keeps the diff correct.
export function sourceSnapshots(source, { changes = [], current = [], total = 0 }, lbl) {
  const before = [], after = [];
  const changedKeys = new Set();
  let changedPresentNow = 0;
  for (const c of changes) {
    changedKeys.add(c.rowId);
    const thenRow = c.firstOp === 'I' ? null : c.firstPrev;
    const nowRow = c.lastOp === 'D' ? null : c.lastData;
    if (isPresent(thenRow)) before.push(toItem(source, thenRow, lbl));
    if (isPresent(nowRow)) { after.push(toItem(source, nowRow, lbl)); changedPresentNow++; }
  }
  let listed = 0;
  for (const row of current) {
    if (changedKeys.has(rowKey(source.table, row))) continue;
    const item = toItem(source, row, lbl);
    before.push(item); after.push(item); listed++;
  }
  const omitted = Math.max(0, total - changedPresentNow - listed);
  return { before, after, omitted };
}

// The manager is an attribute (managerId) shown as a relationship.
function managerItems(row, lbl) {
  const id = row?.managerId;
  if (!id) return [];
  return [{ key: `manager:${id}`, group: 'Manager', label: lbl.principal(id) || id, kind: 'user', id, detail: '' }];
}

function snapshot(row, items) {
  return {
    exists: !!row,
    deleted: !!row?.deletedAt,
    attributes: attributeMap(row),
    relationships: items,
  };
}

// Assemble both snapshots.
//   thenRow / nowRow: the entity's own row at T and now (null = didn't exist)
//   sources:          [{ source, changes, current, total }]
//   labels:           { resource(id), principal(id), identity(id) } lookups
export function buildDiffSnapshots({ thenRow, nowRow, sources = [], labels = {} }) {
  const lbl = {
    resource: labels.resource || (() => null),
    principal: labels.principal || (() => null),
    identity: labels.identity || (() => null),
  };
  const beforeItems = managerItems(thenRow, lbl);
  const afterItems = managerItems(nowRow, lbl);
  let omittedUnchanged = 0;
  for (const s of sources) {
    const r = sourceSnapshots(s.source, s, lbl);
    beforeItems.push(...r.before);
    afterItems.push(...r.after);
    omittedUnchanged += r.omitted;
  }
  return {
    before: snapshot(thenRow, beforeItems),
    after: snapshot(nowRow, afterItems),
    omittedUnchanged,
  };
}
