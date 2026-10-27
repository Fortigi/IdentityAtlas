// Entity-timeline endpoints + the pure timeline builders they use —
// GET /api/{user,resources,access-package,identities,contexts}/:id/timeline.
//
// The builders (diffRow / timeline*Events / buildEntityTimeline) are pure and
// exported for unit tests (recentChanges.timeline.test.js); routes/recentChanges.js
// re-exports them. Extracted verbatim from routes/recentChanges.js (audit finding
// C1); mounted via router.use() so the public paths are unchanged. Pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql, UUID_RE, clampTimelineDays, clampLimit, toEvent, resourceCounterpartyKind, changeAction } from './shared.js';

const router = Router();

// ─── Timeline helpers (pure, exported for unit tests) ─────────────────
//
// The user Timeline merges two kinds of change from `_history`:
//   • attribute updates — every changed scalar field on the Principal row
//   • relationship changes — resource assignments, identity links, manager
// into one time-sorted stream. The functions below are pure so they can be
// unit-tested without a database; the route handler resolves counterparty
// labels and calls them.

// Bookkeeping / sync-churn columns that change on every crawl — excluded so
// the timeline shows meaningful edits, not noise. managerId is handled as its
// own relationship event, so it's skipped here too.
// deletedAt is skipped too: crossing it is its own "Deleted / Restored in source"
// event (see timelineAttrEvents), not an attribute diff.
export const TIMELINE_SKIP_FIELDS = new Set([
  'id', 'ValidFrom', 'ValidTo', '_operation',
  'managerId', 'extendedAttributes', 'deletedAt',
  'createdAt', 'updatedAt', 'lastSyncedAt', 'lastSeenAt',
  'lastActivityDateTime', 'syncRunId',
]);

// Server-side mirror of utils/formatValue so attribute diffs read the same as
// the old Version History table.
function formatHistoryValue(val) {
  if (val === null || val === undefined) return '—';
  if (val === true) return 'Yes';
  if (val === false) return 'No';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// Diff two row snapshots → [{ field, from, to }] for changed scalar fields,
// mirroring computeHistoryDiffs' skip rules. Generic across entity tables.
export function diffRow(prev, next) {
  const before = prev || {};
  const after = next || {};
  const changes = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const field of keys) {
    if (TIMELINE_SKIP_FIELDS.has(field)) continue;
    const from = formatHistoryValue(before[field]);
    const to = formatHistoryValue(after[field]);
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}

function humanizeField(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

const ATTR_TABLES = new Set(['Principals', 'Resources', 'Identities', 'Contexts']);

// Build the merged, time-sorted timeline from raw _history rows (newest-first)
// for ANY entity (user / resource / access-package / identity). `entityId` is
// used to detect which side of a join we're viewing (e.g. on a resource page a
// ResourceAssignment's counterparty is the principal; on a user page it's the
// resource). `labels` provides synchronous lookups resolved by the caller:
//   { resource(id) -> {displayName,resourceType}, principal(id) -> name,
//     identity(id) -> name }
// Attribute-table row (Principals / Resources / Identities / Contexts) →
// attribute-diff events, plus a manager-change relationship event for Principals.
export function timelineAttrEvents(row, entityId, acc, lbl) {
  const data = row.rowData || {};
  const prev = row.prevData || {};
  // A Resources row for some OTHER resource only reaches here on a user's
  // timeline: a resource the user holds that was deleted or restored in the
  // source. Without it, a deleted business role vanished from the user's
  // access without a trace on their timeline.
  const rowEntityId = data.id || prev.id;
  if (row.tableName === 'Resources' && rowEntityId && rowEntityId !== entityId) {
    heldResourceEvent(row, data, prev, acc);
    return;
  }
  // The entity itself soft-deleted (deletedAt stamped) or restored — an UPDATE
  // in the audit trail, but to a reader a deletion, not an attribute edit.
  const softAction = row.operation === 'U' ? changeAction(row) : null;
  if (softAction === 'removed') {
    acc.removedCount++; acc.events.push(toEvent(row, 'Deleted in source', { eventKind: 'attribute' }));
  } else if (softAction === 'added') {
    acc.addedCount++; acc.events.push(toEvent(row, 'Restored in source', { eventKind: 'attribute' }));
  }
  // Manager change (Principals only) → its own relationship event.
  if (row.tableName === 'Principals' && row.operation === 'U') {
    const before = prev.managerId || null, after = data.managerId || null;
    if (before !== after) {
      const name = lbl.principal(after) || after || '(none)';
      acc.changedCount++;
      acc.events.push(toEvent(row, after ? `Manager changed to ${name}` : 'Manager removed',
        { kind: after ? 'user' : null, id: after, label: name, eventKind: 'manager' }));
    }
  }
  if (row.operation === 'U') {
    for (const c of diffRow(prev, data)) {
      acc.changedCount++;
      acc.events.push({
        at: row.changedAt, operation: 'changed', eventKind: 'attribute',
        summary: `${humanizeField(c.field)}: ${c.from} → ${c.to}`,
        counterpartyKind: null, counterpartyId: null, counterpartyLabel: null, attribute: c,
      });
    }
  } else if (row.operation === 'I') {
    acc.addedCount++; acc.events.push(toEvent(row, 'Created', { eventKind: 'attribute' }));
  } else if (row.operation === 'D') {
    acc.removedCount++; acc.events.push(toEvent(row, 'Deleted', { eventKind: 'attribute' }));
  }
}

// A resource the viewed user holds was deleted / restored in the source. Only a
// crossing of deletedAt counts; any other edit to that resource is its own
// page's business, not the user's. The name comes from the snapshot, so it
// reads right even if the resource has since been renamed or removed.
function heldResourceEvent(row, data, prev, acc) {
  if (row.operation === 'I') return;
  const action = changeAction(row);
  if (!action) return;
  const id = data.id || prev.id;
  const name = data.displayName || prev.displayName || id;
  const kind = resourceCounterpartyKind(data.resourceType || prev.resourceType);
  const removed = action === 'removed';
  if (removed) acc.removedCount++; else acc.addedCount++;
  acc.events.push(toEvent(row, `${name} ${removed ? 'deleted' : 'restored'} in source`,
    { kind, id, label: name, eventKind: 'assignment' }));
}

// Bump the added/removed counter for an action and report whether it was an
// addition. Shared by the relationship-style handlers below.
function countAction(acc, action) {
  if (action === 'added') { acc.addedCount++; return true; }
  acc.removedCount++; return false;
}

// ResourceAssignments row → assignment event. Counterparty is the resource when
// we're viewing the principal, or the principal when viewing the resource.
// changeAction() decides added/removed: a removal is a soft delete (an UPDATE
// stamping deletedAt), so looking for 'D' alone showed no removal at all.
export function timelineAssignmentEvents(row, entityId, acc, lbl) {
  const action = changeAction(row);
  if (!action) return;
  const data = row.rowData || {};
  const prev = row.prevData || {};
  const princId = data.principalId || prev.principalId;
  const resId = data.resourceId || prev.resourceId;
  const assignType = data.assignmentType || prev.assignmentType;
  const suffix = assignType ? ` (${assignType})` : '';
  const added = countAction(acc, action);
  if (princId === entityId) {
    // We're the principal — counterparty is the resource.
    const info = lbl.resource(resId); const name = info?.displayName || resId;
    const kind = resourceCounterpartyKind(info?.resourceType);
    acc.events.push(toEvent(row, `${added ? 'Added to' : 'Removed from'} ${name}${suffix}`, { kind, id: resId, label: name, eventKind: 'assignment' }));
  } else {
    // We're the resource — counterparty is the principal.
    const name = lbl.principal(princId) || princId;
    acc.events.push(toEvent(row, `${name} ${added ? 'granted' : 'removed'}${suffix}`, { kind: 'user', id: princId, label: name, eventKind: 'assignment' }));
  }
}

// ResourceRelationships row → containment event, phrased from the viewed
// entity's side (child sees "Added to", parent sees "Now contains").
export function timelineRelationshipEvents(row, entityId, acc, lbl) {
  // An update that touched neither side (a backfilled column) is no change —
  // it used to fall through to "Removed from".
  const action = changeAction(row);
  if (!action) return;
  const data = row.rowData || {};
  const prev = row.prevData || {};
  const childId = data.childResourceId || prev.childResourceId;
  const parentId = data.parentResourceId || prev.parentResourceId;
  const relType = data.relationshipType || prev.relationshipType;
  const usIsChild = childId === entityId;
  const otherId = usIsChild ? parentId : childId;
  const info = lbl.resource(otherId); const name = info?.displayName || otherId;
  const added = countAction(acc, action);
  const verb = usIsChild
    ? (added ? 'Added to' : 'Removed from')
    : (added ? 'Now contains' : 'No longer contains');
  acc.events.push(toEvent(row, `${verb} ${name}${relType ? ` (${relType})` : ''}`,
    { kind: resourceCounterpartyKind(info?.resourceType), id: otherId, label: name, eventKind: 'relationship' }));
}

// IdentityMembers row → account-link event. Counterparty is the linked account
// when viewing the identity, or the identity when viewing the principal.
export function timelineIdentityMemberEvents(row, entityId, acc, lbl) {
  const action = changeAction(row);
  if (!action) return;
  const data = row.rowData || {};
  const prev = row.prevData || {};
  const identId = data.identityId || prev.identityId;
  const princId = data.principalId || prev.principalId;
  const added = countAction(acc, action);
  if (identId === entityId) {
    // We're the identity — counterparty is the linked account (principal).
    const name = lbl.principal(princId) || princId;
    acc.events.push(toEvent(row, `Account ${name} ${added ? 'linked' : 'unlinked'}`, { kind: 'user', id: princId, label: name, eventKind: 'identity-member' }));
  } else {
    // We're the principal — counterparty is the identity.
    const name = lbl.identity(identId) || identId;
    acc.events.push(toEvent(row, `${added ? 'Linked to' : 'Unlinked from'} identity ${name}`, { kind: 'identity', id: identId, label: name, eventKind: 'identity-member' }));
  }
}

export function buildEntityTimeline(entityKind, entityId, rows, labels = {}) {
  const lbl = {
    resource: labels.resource || (() => null),
    principal: labels.principal || (() => null),
    identity: labels.identity || (() => null),
  };
  const acc = { events: [], addedCount: 0, removedCount: 0, changedCount: 0 };

  for (const row of rows) {
    const t = row.tableName;
    if (ATTR_TABLES.has(t)) timelineAttrEvents(row, entityId, acc, lbl);
    else if (t === 'ResourceAssignments') timelineAssignmentEvents(row, entityId, acc, lbl);
    else if (t === 'ResourceRelationships') timelineRelationshipEvents(row, entityId, acc, lbl);
    else if (t === 'IdentityMembers') timelineIdentityMemberEvents(row, entityId, acc, lbl);
  }

  acc.events.sort((a, b) => new Date(b.at) - new Date(a.at));
  return acc;
}

// Batch-resolve counterparty labels referenced by a set of history rows
// (avoids per-row N+1). Over-fetches across all three kinds — cheap and simple.
async function resolveTimelineLabels(rows) {
  const resIds = new Set(), princIds = new Set(), identIds = new Set();
  const add = (set, ...vals) => vals.forEach(v => v && set.add(v));
  for (const row of rows) {
    const d = row.rowData || {}, p = row.prevData || {};
    switch (row.tableName) {
      case 'ResourceAssignments': add(resIds, d.resourceId, p.resourceId); add(princIds, d.principalId, p.principalId); break;
      case 'ResourceRelationships': add(resIds, d.childResourceId, p.childResourceId, d.parentResourceId, p.parentResourceId); break;
      case 'IdentityMembers': add(identIds, d.identityId, p.identityId); add(princIds, d.principalId, p.principalId); break;
      case 'Principals': add(princIds, d.managerId, p.managerId); break;
      default: break;
    }
  }
  const [resRows, princRows, identRows] = await Promise.all([
    resIds.size ? db.query(`SELECT id, "displayName", "resourceType" FROM "Resources" WHERE id = ANY($1)`, [[...resIds]]) : { rows: [] },
    princIds.size ? db.query(`SELECT id, "displayName" FROM "Principals" WHERE id = ANY($1)`, [[...princIds]]) : { rows: [] },
    identIds.size ? db.query(`SELECT id, "displayName" FROM "Identities" WHERE id = ANY($1)`, [[...identIds]]) : { rows: [] },
  ]);
  const resMap = new Map(resRows.rows.map(x => [x.id, { displayName: x.displayName, resourceType: x.resourceType }]));
  const princMap = new Map(princRows.rows.map(x => [x.id, x.displayName]));
  const identMap = new Map(identRows.rows.map(x => [x.id, x.displayName]));
  return {
    resource: id => resMap.get(id) || null,
    principal: id => princMap.get(id) || null,
    identity: id => identMap.get(id) || null,
  };
}

// Map a raw history row's jsonb snapshot into an event. The caller
// supplies the summary-builder + counterparty-kind because it knows
// what this table means for the entity being viewed.
// ─── Timeline endpoints ──────────────────────────────────────────────
// Unified, date-ranged history for the entity-detail Timeline tab: attribute
// updates + relationship changes in one stream, for user / resource /
// access-package / identity. Wider window than recent-changes; auth-only like
// its siblings.
//
// Retention note: `_history` is unbounded (migration 009 defers retention),
// so the window (sinceDays) and LIMIT bound the work; the
// ("tableName","rowId","changedAt") / ("changedAt") indexes cover the WHERE.
async function runTimeline(res, { entityKind, id, sinceDays, limit, where }) {
  const r = await db.query(`
    SELECT "tableName", operation, "changedAt", "rowData", "prevData"
      FROM "_history"
     WHERE "changedAt" > now() - ($1::int || ' days')::interval AND (${where})
     ORDER BY "changedAt" DESC
     LIMIT $3
  `, [sinceDays, id, limit * 2]);
  const labels = await resolveTimelineLabels(r.rows);
  const built = buildEntityTimeline(entityKind, id, r.rows, labels);

  // Access-review activity isn't in _history (CertificationDecisions isn't
  // tracked), but each review instance has real start/end dates — surface them
  // as "Access review started/ended" events so they show on the timeline.
  if (entityKind === 'access-package' || entityKind === 'resource') {
    const reviewEvents = await reviewInstanceEvents(id);
    if (reviewEvents.length) {
      built.events.push(...reviewEvents);
      built.changedCount += reviewEvents.length;
      built.events.sort((a, b) => new Date(b.at) - new Date(a.at));
    }
  }

  built.events = built.events.slice(0, limit);
  res.json({ sinceDays, ...built });
}

// Synthesize "Access review started / ended" timeline events from a resource's
// review instances (distinct reviewInstanceId in CertificationDecisions).
// Reviews are sparse governance milestones, so — unlike attribute/relationship
// events — these are NOT clipped to the selected window; the most recent review
// should always be visible on the timeline.
async function reviewInstanceEvents(id) {
  const out = [];
  try {
    const r = await db.query(`
      SELECT DISTINCT "reviewInstanceId" AS ii,
             "reviewInstanceStartDateTime" AS st,
             "reviewInstanceEndDateTime"   AS en,
             "reviewInstanceStatus"        AS status
        FROM "CertificationDecisions"
       WHERE "resourceId"::text = $1 AND "reviewInstanceId" IS NOT NULL`, [id]);
    const now = Date.now();
    for (const row of r.rows) {
      if (row.st) {
        out.push({ at: row.st, operation: 'added', eventKind: 'review', summary: 'Access review started',
          counterpartyKind: null, counterpartyId: null, counterpartyLabel: null });
      }
      if (row.en && new Date(row.en).getTime() <= now) {
        out.push({ at: row.en, operation: 'changed', eventKind: 'review',
          summary: `Access review ${row.status === 'Completed' ? 'completed' : 'ended'}`,
          counterpartyKind: null, counterpartyId: null, counterpartyLabel: null });
      }
    }
  } catch { /* CertificationDecisions may not exist */ }
  return out;
}

// Per-entity _history WHERE clauses ($2 = entity id).
const TIMELINE_WHERE = {
  // The last arm: a resource this user holds (or held) that was deleted or
  // restored in the source — only rows that crossed the deletedAt line, so a
  // held resource's ordinary edits stay off the user's timeline.
  user: `("tableName" = 'ResourceAssignments' AND "rowData"->>'principalId' = $2)
      OR ("tableName" = 'IdentityMembers'   AND "rowData"->>'principalId' = $2)
      OR ("tableName" = 'Principals'         AND "rowId" = $2)
      OR ("tableName" = 'Resources' AND operation = 'U'
          AND (("prevData"->>'deletedAt') IS NULL) <> (("rowData"->>'deletedAt') IS NULL)
          AND "rowId" IN (SELECT ra."resourceId"::text FROM "ResourceAssignments" ra
                           WHERE ra."principalId"::text = $2))`,
  resource: `("tableName" = 'ResourceAssignments' AND "rowData"->>'resourceId' = $2)
      OR ("tableName" = 'ResourceRelationships' AND ("rowData"->>'childResourceId' = $2 OR "rowData"->>'parentResourceId' = $2))
      OR ("tableName" = 'Resources' AND "rowId" = $2)`,
  'access-package': `("tableName" = 'ResourceAssignments' AND "rowData"->>'resourceId' = $2)
      OR ("tableName" = 'ResourceRelationships' AND "rowData"->>'parentResourceId' = $2 AND COALESCE("rowData"->>'relationshipType','') = 'Contains')
      OR ("tableName" = 'Resources' AND "rowId" = $2)`,
  identity: `("tableName" = 'IdentityMembers' AND "rowData"->>'identityId' = $2)
      OR ("tableName" = 'Identities' AND "rowId" = $2)`,
  // ContextMembers isn't history-tracked (it's owned by its parent context),
  // so a context timeline reflects the context row's own changes.
  context: `("tableName" = 'Contexts' AND "rowId" = $2)`,
};

export function timelineHandler(entityKind) {
  return async (req, res) => {
    if (!useSql) return res.json({ sinceDays: 0, events: [], addedCount: 0, removedCount: 0, changedCount: 0 });
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
    const sinceDays = clampTimelineDays(req.query.sinceDays);
    const limit = clampLimit(req.query.limit);
    try {
      await runTimeline(res, { entityKind, id, sinceDays, limit, where: TIMELINE_WHERE[entityKind] });
    } catch (err) {
      console.error(`${entityKind} timeline failed:`, err.message);
      res.status(500).json({ error: 'Failed to load timeline' });
    }
  };
}

router.get('/user/:id/timeline', timelineHandler('user'));
router.get('/resources/:id/timeline', timelineHandler('resource'));
router.get('/access-package/:id/timeline', timelineHandler('access-package'));
router.get('/identities/:id/timeline', timelineHandler('identity'));
router.get('/contexts/:id/timeline', timelineHandler('context'));

export default router;
