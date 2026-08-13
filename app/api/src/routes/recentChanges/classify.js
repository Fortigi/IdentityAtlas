// Row classifiers for the per-entity recent-changes panels, extracted from
// recentChanges/changes.js so each handler stays under the complexity threshold
// (/resources was cognitive 42, /user 38, /access-package 17). Each classifier
// maps one _history row to { event, added, removed } (event may be null);
// collectHistoryEvents runs the shared accumulation loop that every handler used
// to inline. Classification + counting are moved verbatim — no behaviour change.

import { toEvent, lookupResource, lookupIdentity, lookupPrincipal, resourceCounterpartyKind } from './shared.js';

const NONE = { event: null, added: 0, removed: 0 };

// Shared loop: classify each row, collect its event, and accumulate the
// add/remove counts — stopping once `limit` events have been gathered. A row
// that classifies to no event neither pushes nor counts (matching the inline
// loops, where the counters only moved alongside a pushed event).
export async function collectHistoryEvents(rows, limit, classify) {
  const events = [];
  let addedCount = 0, removedCount = 0;
  for (const row of rows) {
    if (events.length >= limit) break;
    const { event, added, removed } = await classify(row);
    if (event) {
      events.push(event);
      addedCount += added;
      removedCount += removed;
    }
  }
  return { events, addedCount, removedCount };
}

// ── /user ───────────────────────────────────────────────────────────
async function userAssignmentEvent(row, data, prev) {
  const resId = data.resourceId;
  const resInfo = await lookupResource(resId);
  const resName = resInfo?.displayName || resId;
  const kind = resourceCounterpartyKind(resInfo?.resourceType);
  const assignType = data.assignmentType || prev.assignmentType;
  if (row.operation === 'I') {
    return { event: toEvent(row, `Added to ${resName}${assignType ? ` (${assignType})` : ''}`,
      { kind, id: resId, label: resName, eventKind: 'assignment' }), added: 1, removed: 0 };
  }
  if (row.operation === 'D') {
    return { event: toEvent(row, `Removed from ${resName}${assignType ? ` (${assignType})` : ''}`,
      { kind, id: resId, label: resName, eventKind: 'assignment' }), added: 0, removed: 1 };
  }
  return NONE;
}

async function userIdentityMemberEvent(row, data) {
  const identId = data.identityId;
  const label = await lookupIdentity(identId) || identId;
  if (row.operation === 'I') {
    return { event: toEvent(row, `Linked to identity ${label}`,
      { kind: 'identity', id: identId, label, eventKind: 'identity-member' }), added: 0, removed: 0 };
  }
  if (row.operation === 'D') {
    return { event: toEvent(row, `Unlinked from identity ${label}`,
      { kind: 'identity', id: identId, label, eventKind: 'identity-member' }), added: 0, removed: 0 };
  }
  return NONE;
}

async function userManagerEvent(row, data, prev) {
  const before = prev.managerId || null;
  const after  = data.managerId || null;
  if (before === after) return NONE;
  const newLabel = await lookupPrincipal(after) || after || '(none)';
  return { event: toEvent(row, after ? `Manager changed to ${newLabel}` : `Manager removed`,
    { kind: after ? 'user' : null, id: after, label: newLabel, eventKind: 'manager' }), added: 0, removed: 0 };
}

export function classifyUserRow(row) {
  const data = row.rowData || {};
  const prev = row.prevData || {};
  if (row.tableName === 'ResourceAssignments') return userAssignmentEvent(row, data, prev);
  if (row.tableName === 'IdentityMembers') return userIdentityMemberEvent(row, data);
  if (row.tableName === 'Principals' && row.operation === 'U') return userManagerEvent(row, data, prev);
  return Promise.resolve(NONE);
}

// ── /resources ──────────────────────────────────────────────────────
async function resourceAssignmentEvent(row, data, prev) {
  const princId = data.principalId;
  const label = await lookupPrincipal(princId) || princId;
  const assignType = data.assignmentType || prev.assignmentType;
  if (row.operation === 'I') {
    return { event: toEvent(row, `${label} granted${assignType ? ` (${assignType})` : ''}`,
      { kind: 'user', id: princId, label, eventKind: 'assignment' }), added: 1, removed: 0 };
  }
  if (row.operation === 'D') {
    return { event: toEvent(row, `${label} removed${assignType ? ` (${assignType})` : ''}`,
      { kind: 'user', id: princId, label, eventKind: 'assignment' }), added: 0, removed: 1 };
  }
  return NONE;
}

async function resourceRelationshipEvent(row, data, prev, resId) {
  // Figure out which side is "us" and which is the counterparty.
  const childId  = data.childResourceId;
  const parentId = data.parentResourceId;
  const usIsChild = childId === resId;
  const otherId = usIsChild ? parentId : childId;
  const otherInfo = await lookupResource(otherId);
  const otherName = otherInfo?.displayName || otherId;
  const relType = data.relationshipType || prev.relationshipType;
  const verb = usIsChild ? (row.operation === 'I' ? 'Added to' : 'Removed from')
                          : (row.operation === 'I' ? 'Contained' : 'No longer contains');
  return {
    event: toEvent(row, `${verb} ${otherName}${relType ? ` (${relType})` : ''}`,
      { kind: resourceCounterpartyKind(otherInfo?.resourceType), id: otherId, label: otherName, eventKind: 'relationship' }),
    added: row.operation === 'I' ? 1 : 0,
    removed: row.operation === 'D' ? 1 : 0,
  };
}

export function classifyResourceRow(row, resId) {
  const data = row.rowData || {};
  const prev = row.prevData || {};
  if (row.tableName === 'ResourceAssignments') return resourceAssignmentEvent(row, data, prev);
  if (row.tableName === 'ResourceRelationships') return resourceRelationshipEvent(row, data, prev, resId);
  return Promise.resolve(NONE);
}

// ── /access-package (governance-filtered) ────────────────────────────
async function apAssignmentEvent(row, data) {
  const princId = data.principalId;
  const label = await lookupPrincipal(princId) || princId;
  if (row.operation === 'I') {
    return { event: toEvent(row, `${label} granted this role`,
      { kind: 'user', id: princId, label, eventKind: 'assignment' }), added: 1, removed: 0 };
  }
  if (row.operation === 'D') {
    return { event: toEvent(row, `${label} lost this role`,
      { kind: 'user', id: princId, label, eventKind: 'assignment' }), added: 0, removed: 1 };
  }
  return NONE;
}

async function apRelationshipEvent(row, data) {
  const childId = data.childResourceId;
  const info = await lookupResource(childId);
  const label = info?.displayName || childId;
  if (row.operation === 'I') {
    return { event: toEvent(row, `${label} added to this role`,
      { kind: resourceCounterpartyKind(info?.resourceType), id: childId, label, eventKind: 'relationship' }), added: 1, removed: 0 };
  }
  if (row.operation === 'D') {
    return { event: toEvent(row, `${label} removed from this role`,
      { kind: resourceCounterpartyKind(info?.resourceType), id: childId, label, eventKind: 'relationship' }), added: 0, removed: 1 };
  }
  return NONE;
}

export function classifyAccessPackageRow(row) {
  const data = row.rowData || {};
  if (row.tableName === 'ResourceAssignments') return apAssignmentEvent(row, data);
  if (row.tableName === 'ResourceRelationships') return apRelationshipEvent(row, data);
  return Promise.resolve(NONE);
}

// ── /identities ──────────────────────────────────────────────────────
export async function classifyIdentityRow(row) {
  const data = row.rowData || {};
  const princId = data.principalId;
  const label = await lookupPrincipal(princId) || data.displayName || princId;
  if (row.operation === 'I') {
    return { event: toEvent(row, `Account ${label} linked`,
      { kind: 'user', id: princId, label, eventKind: 'identity-member' }), added: 1, removed: 0 };
  }
  if (row.operation === 'D') {
    return { event: toEvent(row, `Account ${label} unlinked`,
      { kind: 'user', id: princId, label, eventKind: 'identity-member' }), added: 0, removed: 1 };
  }
  return NONE;
}
