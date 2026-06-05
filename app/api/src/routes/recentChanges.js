// ─── Recent Changes API ──────────────────────────────────────────────
//
// Per-entity timelines built from the `_history` audit table. Captures
// "relationship"-type changes — new assignments, removed assignments,
// manager changes, resource containment shifts, linked-account add/remove
// — so support staff investigating a user's permission issue can see at
// a glance what recently moved.
//
// Endpoints:
//   GET /api/user/:id/recent-changes
//   GET /api/resources/:id/recent-changes
//   GET /api/access-package/:id/recent-changes
//   GET /api/identities/:id/recent-changes
//
// Query params:
//   sinceDays  — window in days (default 30, max 365)
//   limit      — max events returned (default 50, max 500)
//
// Response shape:
//   {
//     sinceDays, addedCount, removedCount, events: [
//       { at, operation: 'added'|'removed'|'changed',
//         eventKind, summary,
//         counterpartyKind, counterpartyId, counterpartyLabel }
//     ]
//   }

import { Router } from 'express';
import * as db from '../db/connection.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampDays(v) {
  const n = parseInt(v, 10);
  if (!n || n < 1) return 30;
  return Math.min(365, n);
}
function clampLimit(v) {
  const n = parseInt(v, 10);
  if (!n || n < 1) return 50;
  return Math.min(500, n);
}
// The Timeline tab wants a wider window than the recent-changes panel, so it
// has its own clamp (default 90 days, up to ~3 years). Kept separate from
// clampDays so the 365-day cap other endpoints rely on is untouched.
function clampTimelineDays(v) {
  const n = parseInt(v, 10);
  if (!n || n < 1) return 90;
  return Math.min(1095, n);
}

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
export const TIMELINE_SKIP_FIELDS = new Set([
  'id', 'ValidFrom', 'ValidTo', '_operation',
  'managerId', 'extendedAttributes',
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
export function buildEntityTimeline(entityKind, entityId, rows, labels = {}) {
  const resource = labels.resource || (() => null);
  const principal = labels.principal || (() => null);
  const identity = labels.identity || (() => null);
  const events = [];
  let addedCount = 0, removedCount = 0, changedCount = 0;

  const pushAttr = (row, c) => {
    changedCount++;
    events.push({
      at: row.changedAt, operation: 'changed', eventKind: 'attribute',
      summary: `${humanizeField(c.field)}: ${c.from} → ${c.to}`,
      counterpartyKind: null, counterpartyId: null, counterpartyLabel: null, attribute: c,
    });
  };

  for (const row of rows) {
    const data = row.rowData || {};
    const prev = row.prevData || {};
    const t = row.tableName;

    if (ATTR_TABLES.has(t)) {
      // Manager change (Principals only) → its own relationship event.
      if (t === 'Principals' && row.operation === 'U') {
        const before = prev.managerId || null, after = data.managerId || null;
        if (before !== after) {
          const lbl = principal(after) || after || '(none)';
          changedCount++;
          events.push(toEvent(row, after ? `Manager changed to ${lbl}` : 'Manager removed',
            { kind: after ? 'user' : null, id: after, label: lbl, eventKind: 'manager' }));
        }
      }
      if (row.operation === 'U') {
        for (const c of diffRow(prev, data)) pushAttr(row, c);
      } else if (row.operation === 'I') {
        addedCount++; events.push(toEvent(row, 'Created', { eventKind: 'attribute' }));
      } else if (row.operation === 'D') {
        removedCount++; events.push(toEvent(row, 'Deleted', { eventKind: 'attribute' }));
      }
      continue;
    }

    if (t === 'ResourceAssignments') {
      const princId = data.principalId || prev.principalId;
      const resId = data.resourceId || prev.resourceId;
      const assignType = data.assignmentType || prev.assignmentType;
      const suffix = assignType ? ` (${assignType})` : '';
      if (princId === entityId) {
        // We're the principal — counterparty is the resource.
        const info = resource(resId); const name = info?.displayName || resId;
        const kind = resourceCounterpartyKind(info?.resourceType);
        if (row.operation === 'I') { addedCount++; events.push(toEvent(row, `Added to ${name}${suffix}`, { kind, id: resId, label: name, eventKind: 'assignment' })); }
        else if (row.operation === 'D') { removedCount++; events.push(toEvent(row, `Removed from ${name}${suffix}`, { kind, id: resId, label: name, eventKind: 'assignment' })); }
      } else {
        // We're the resource — counterparty is the principal.
        const name = principal(princId) || princId;
        if (row.operation === 'I') { addedCount++; events.push(toEvent(row, `${name} granted${suffix}`, { kind: 'user', id: princId, label: name, eventKind: 'assignment' })); }
        else if (row.operation === 'D') { removedCount++; events.push(toEvent(row, `${name} removed${suffix}`, { kind: 'user', id: princId, label: name, eventKind: 'assignment' })); }
      }
      continue;
    }

    if (t === 'ResourceRelationships') {
      const childId = data.childResourceId || prev.childResourceId;
      const parentId = data.parentResourceId || prev.parentResourceId;
      const relType = data.relationshipType || prev.relationshipType;
      const usIsChild = childId === entityId;
      const otherId = usIsChild ? parentId : childId;
      const info = resource(otherId); const name = info?.displayName || otherId;
      const verb = usIsChild
        ? (row.operation === 'I' ? 'Added to' : 'Removed from')
        : (row.operation === 'I' ? 'Now contains' : 'No longer contains');
      if (row.operation === 'I') addedCount++; else if (row.operation === 'D') removedCount++;
      events.push(toEvent(row, `${verb} ${name}${relType ? ` (${relType})` : ''}`,
        { kind: resourceCounterpartyKind(info?.resourceType), id: otherId, label: name, eventKind: 'relationship' }));
      continue;
    }

    if (t === 'IdentityMembers') {
      const identId = data.identityId || prev.identityId;
      const princId = data.principalId || prev.principalId;
      if (identId === entityId) {
        // We're the identity — counterparty is the linked account (principal).
        const name = principal(princId) || princId;
        if (row.operation === 'I') { addedCount++; events.push(toEvent(row, `Account ${name} linked`, { kind: 'user', id: princId, label: name, eventKind: 'identity-member' })); }
        else if (row.operation === 'D') { removedCount++; events.push(toEvent(row, `Account ${name} unlinked`, { kind: 'user', id: princId, label: name, eventKind: 'identity-member' })); }
      } else {
        // We're the principal — counterparty is the identity.
        const name = identity(identId) || identId;
        if (row.operation === 'I') { addedCount++; events.push(toEvent(row, `Linked to identity ${name}`, { kind: 'identity', id: identId, label: name, eventKind: 'identity-member' })); }
        else if (row.operation === 'D') { removedCount++; events.push(toEvent(row, `Unlinked from identity ${name}`, { kind: 'identity', id: identId, label: name, eventKind: 'identity-member' })); }
      }
      continue;
    }
  }

  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  return { events, addedCount, removedCount, changedCount };
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
function toEvent(row, summary, counterparty) {
  const op = row.operation === 'I' ? 'added' : row.operation === 'D' ? 'removed' : 'changed';
  return {
    at: row.changedAt,
    operation: op,
    eventKind: counterparty?.eventKind || 'other',
    summary,
    counterpartyKind: counterparty?.kind || null,
    counterpartyId: counterparty?.id || null,
    counterpartyLabel: counterparty?.label || null,
  };
}

// Tiny display-name helpers. Look up by current state first; fall back
// to whatever name was stored in the history snapshot so rows stay
// readable even when the counterparty has since been deleted.
async function lookupPrincipal(id) {
  if (!id) return null;
  try {
    const r = await db.queryOne(`SELECT "displayName" FROM "Principals" WHERE id = $1`, [id]);
    return r?.displayName || null;
  } catch { return null; }
}
async function lookupResource(id) {
  if (!id) return null;
  try {
    const r = await db.queryOne(`SELECT "displayName", "resourceType" FROM "Resources" WHERE id = $1`, [id]);
    return r || null;
  } catch { return null; }
}
async function lookupIdentity(id) {
  if (!id) return null;
  try {
    const r = await db.queryOne(`SELECT "displayName" FROM "Identities" WHERE id = $1`, [id]);
    return r?.displayName || null;
  } catch { return null; }
}

// Kind mapping for counterparty — so the UI can route a click to the
// right detail tab. A BusinessRole resource is shown as access-package;
// everything else as resource.
function resourceCounterpartyKind(resType) {
  return resType === 'BusinessRole' ? 'access-package' : 'resource';
}

// ─── /api/user/:id/recent-changes ────────────────────────────────────
router.get('/user/:id/recent-changes', async (req, res) => {
  if (!useSql) return res.json({ sinceDays: 0, events: [], addedCount: 0, removedCount: 0 });
  const userId = req.params.id;
  if (!UUID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user id' });

  const sinceDays = clampDays(req.query.sinceDays);
  const limit = clampLimit(req.query.limit);
  try {
    // Pull every candidate _history row in one query so we can sort by
    // changedAt cheaply; we enrich + classify in JS.
    const r = await db.query(`
      SELECT "tableName", operation, "changedAt", "rowData", "prevData"
        FROM "_history"
       WHERE "changedAt" > now() - ($1::int || ' days')::interval
         AND (
           ("tableName" = 'ResourceAssignments' AND "rowData"->>'principalId' = $2)
           OR ("tableName" = 'IdentityMembers'   AND "rowData"->>'principalId' = $2)
           OR ("tableName" = 'Principals'        AND "rowId" = $2 AND operation = 'U')
         )
       ORDER BY "changedAt" DESC
       LIMIT $3
    `, [sinceDays, userId, limit * 2]);

    const events = [];
    let addedCount = 0, removedCount = 0;

    for (const row of r.rows) {
      if (events.length >= limit) break;
      const data = row.rowData || {};
      const prev = row.prevData || {};
      if (row.tableName === 'ResourceAssignments') {
        const resId = data.resourceId;
        const resInfo = await lookupResource(resId);
        const resName = resInfo?.displayName || resId;
        const kind = resourceCounterpartyKind(resInfo?.resourceType);
        const assignType = data.assignmentType || prev.assignmentType;
        if (row.operation === 'I') {
          addedCount++;
          events.push(toEvent(row, `Added to ${resName}${assignType ? ` (${assignType})` : ''}`,
            { kind, id: resId, label: resName, eventKind: 'assignment' }));
        } else if (row.operation === 'D') {
          removedCount++;
          events.push(toEvent(row, `Removed from ${resName}${assignType ? ` (${assignType})` : ''}`,
            { kind, id: resId, label: resName, eventKind: 'assignment' }));
        }
      } else if (row.tableName === 'IdentityMembers') {
        const identId = data.identityId;
        const label = await lookupIdentity(identId) || identId;
        if (row.operation === 'I') {
          events.push(toEvent(row, `Linked to identity ${label}`,
            { kind: 'identity', id: identId, label, eventKind: 'identity-member' }));
        } else if (row.operation === 'D') {
          events.push(toEvent(row, `Unlinked from identity ${label}`,
            { kind: 'identity', id: identId, label, eventKind: 'identity-member' }));
        }
      } else if (row.tableName === 'Principals' && row.operation === 'U') {
        const before = prev.managerId || null;
        const after  = data.managerId || null;
        if (before !== after) {
          const newLabel = await lookupPrincipal(after) || after || '(none)';
          events.push(toEvent(row,
            after ? `Manager changed to ${newLabel}` : `Manager removed`,
            { kind: after ? 'user' : null, id: after, label: newLabel, eventKind: 'manager' }));
        }
      }
    }

    res.json({ sinceDays, addedCount, removedCount, events });
  } catch (err) {
    console.error('user recent-changes failed:', err.message);
    res.status(500).json({ error: 'Failed to load recent changes' });
  }
});

// ─── /api/resources/:id/recent-changes ───────────────────────────────
router.get('/resources/:id/recent-changes', async (req, res) => {
  if (!useSql) return res.json({ sinceDays: 0, events: [], addedCount: 0, removedCount: 0 });
  const resId = req.params.id;
  if (!UUID_RE.test(resId)) return res.status(400).json({ error: 'Invalid resource id' });

  const sinceDays = clampDays(req.query.sinceDays);
  const limit = clampLimit(req.query.limit);
  try {
    const r = await db.query(`
      SELECT "tableName", operation, "changedAt", "rowData", "prevData"
        FROM "_history"
       WHERE "changedAt" > now() - ($1::int || ' days')::interval
         AND (
           ("tableName" = 'ResourceAssignments'
              AND "rowData"->>'resourceId' = $2)
           OR ("tableName" = 'ResourceRelationships'
              AND ("rowData"->>'childResourceId' = $2 OR "rowData"->>'parentResourceId' = $2))
         )
       ORDER BY "changedAt" DESC
       LIMIT $3
    `, [sinceDays, resId, limit * 2]);

    const events = [];
    let addedCount = 0, removedCount = 0;

    for (const row of r.rows) {
      if (events.length >= limit) break;
      const data = row.rowData || {};
      const prev = row.prevData || {};
      if (row.tableName === 'ResourceAssignments') {
        const princId = data.principalId;
        const label = await lookupPrincipal(princId) || princId;
        const assignType = data.assignmentType || prev.assignmentType;
        if (row.operation === 'I') {
          addedCount++;
          events.push(toEvent(row, `${label} granted${assignType ? ` (${assignType})` : ''}`,
            { kind: 'user', id: princId, label, eventKind: 'assignment' }));
        } else if (row.operation === 'D') {
          removedCount++;
          events.push(toEvent(row, `${label} removed${assignType ? ` (${assignType})` : ''}`,
            { kind: 'user', id: princId, label, eventKind: 'assignment' }));
        }
      } else if (row.tableName === 'ResourceRelationships') {
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
        if (row.operation === 'I') addedCount++;
        else if (row.operation === 'D') removedCount++;
        events.push(toEvent(row, `${verb} ${otherName}${relType ? ` (${relType})` : ''}`,
          { kind: resourceCounterpartyKind(otherInfo?.resourceType), id: otherId, label: otherName, eventKind: 'relationship' }));
      }
    }

    res.json({ sinceDays, addedCount, removedCount, events });
  } catch (err) {
    console.error('resource recent-changes failed:', err.message);
    res.status(500).json({ error: 'Failed to load recent changes' });
  }
});

// ─── /api/access-package/:id/recent-changes ──────────────────────────
// Same underlying data as /api/resources/:id/recent-changes but filtered
// to governance events so a BR's timeline doesn't drown in app-role
// grants.
router.get('/access-package/:id/recent-changes', async (req, res) => {
  if (!useSql) return res.json({ sinceDays: 0, events: [], addedCount: 0, removedCount: 0 });
  const apId = req.params.id;
  if (!UUID_RE.test(apId)) return res.status(400).json({ error: 'Invalid access package id' });

  const sinceDays = clampDays(req.query.sinceDays);
  const limit = clampLimit(req.query.limit);
  try {
    const r = await db.query(`
      SELECT "tableName", operation, "changedAt", "rowData", "prevData"
        FROM "_history"
       WHERE "changedAt" > now() - ($1::int || ' days')::interval
         AND (
           ("tableName" = 'ResourceAssignments'
              AND "rowData"->>'resourceId' = $2
              AND COALESCE("rowData"->>'assignmentType','') = 'Governed')
           OR ("tableName" = 'ResourceRelationships'
              AND "rowData"->>'parentResourceId' = $2
              AND COALESCE("rowData"->>'relationshipType','') = 'Contains')
         )
       ORDER BY "changedAt" DESC
       LIMIT $3
    `, [sinceDays, apId, limit * 2]);

    const events = [];
    let addedCount = 0, removedCount = 0;

    for (const row of r.rows) {
      if (events.length >= limit) break;
      const data = row.rowData || {};
      if (row.tableName === 'ResourceAssignments') {
        const princId = data.principalId;
        const label = await lookupPrincipal(princId) || princId;
        if (row.operation === 'I') {
          addedCount++;
          events.push(toEvent(row, `${label} granted this role`,
            { kind: 'user', id: princId, label, eventKind: 'assignment' }));
        } else if (row.operation === 'D') {
          removedCount++;
          events.push(toEvent(row, `${label} lost this role`,
            { kind: 'user', id: princId, label, eventKind: 'assignment' }));
        }
      } else if (row.tableName === 'ResourceRelationships') {
        const childId = data.childResourceId;
        const info = await lookupResource(childId);
        const label = info?.displayName || childId;
        if (row.operation === 'I') {
          addedCount++;
          events.push(toEvent(row, `${label} added to this role`,
            { kind: resourceCounterpartyKind(info?.resourceType), id: childId, label, eventKind: 'relationship' }));
        } else if (row.operation === 'D') {
          removedCount++;
          events.push(toEvent(row, `${label} removed from this role`,
            { kind: resourceCounterpartyKind(info?.resourceType), id: childId, label, eventKind: 'relationship' }));
        }
      }
    }

    res.json({ sinceDays, addedCount, removedCount, events });
  } catch (err) {
    console.error('access-package recent-changes failed:', err.message);
    res.status(500).json({ error: 'Failed to load recent changes' });
  }
});

// ─── /api/identities/:id/recent-changes ──────────────────────────────
router.get('/identities/:id/recent-changes', async (req, res) => {
  if (!useSql) return res.json({ sinceDays: 0, events: [], addedCount: 0, removedCount: 0 });
  const idenId = req.params.id;
  if (!UUID_RE.test(idenId)) return res.status(400).json({ error: 'Invalid identity id' });

  const sinceDays = clampDays(req.query.sinceDays);
  const limit = clampLimit(req.query.limit);
  try {
    const r = await db.query(`
      SELECT "tableName", operation, "changedAt", "rowData", "prevData"
        FROM "_history"
       WHERE "changedAt" > now() - ($1::int || ' days')::interval
         AND "tableName" = 'IdentityMembers'
         AND "rowData"->>'identityId' = $2
       ORDER BY "changedAt" DESC
       LIMIT $3
    `, [sinceDays, idenId, limit * 2]);

    const events = [];
    let addedCount = 0, removedCount = 0;
    for (const row of r.rows) {
      if (events.length >= limit) break;
      const data = row.rowData || {};
      const princId = data.principalId;
      const label = await lookupPrincipal(princId) || data.displayName || princId;
      if (row.operation === 'I') {
        addedCount++;
        events.push(toEvent(row, `Account ${label} linked`,
          { kind: 'user', id: princId, label, eventKind: 'identity-member' }));
      } else if (row.operation === 'D') {
        removedCount++;
        events.push(toEvent(row, `Account ${label} unlinked`,
          { kind: 'user', id: princId, label, eventKind: 'identity-member' }));
      }
    }

    res.json({ sinceDays, addedCount, removedCount, events });
  } catch (err) {
    console.error('identity recent-changes failed:', err.message);
    res.status(500).json({ error: 'Failed to load recent changes' });
  }
});

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
  user: `("tableName" = 'ResourceAssignments' AND "rowData"->>'principalId' = $2)
      OR ("tableName" = 'IdentityMembers'   AND "rowData"->>'principalId' = $2)
      OR ("tableName" = 'Principals'         AND "rowId" = $2)`,
  resource: `("tableName" = 'ResourceAssignments' AND "rowData"->>'resourceId' = $2)
      OR ("tableName" = 'ResourceRelationships' AND ("rowData"->>'childResourceId' = $2 OR "rowData"->>'parentResourceId' = $2))
      OR ("tableName" = 'Resources' AND "rowId" = $2)`,
  'access-package': `("tableName" = 'ResourceAssignments' AND "rowData"->>'resourceId' = $2 AND COALESCE("rowData"->>'assignmentType','') = 'Governed')
      OR ("tableName" = 'ResourceRelationships' AND "rowData"->>'parentResourceId' = $2 AND COALESCE("rowData"->>'relationshipType','') = 'Contains')
      OR ("tableName" = 'Resources' AND "rowId" = $2)`,
  identity: `("tableName" = 'IdentityMembers' AND "rowData"->>'identityId' = $2)
      OR ("tableName" = 'Identities' AND "rowId" = $2)`,
  // ContextMembers isn't history-tracked (it's owned by its parent context),
  // so a context timeline reflects the context row's own changes.
  context: `("tableName" = 'Contexts' AND "rowId" = $2)`,
};

function timelineHandler(entityKind) {
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
