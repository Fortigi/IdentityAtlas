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

// Diff two Principal snapshots → [{ field, from, to }] for changed scalar
// fields, mirroring computeHistoryDiffs' skip rules.
export function diffPrincipalRow(prev, next) {
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

// Build the merged, time-sorted timeline from raw _history rows (newest-first)
// for a user. `labels` provides synchronous lookups resolved by the caller:
//   { resource(id) -> {displayName,resourceType}, principal(id) -> name,
//     identity(id) -> name }
export function buildUserTimeline(rows, labels = {}) {
  const resource = labels.resource || (() => null);
  const principal = labels.principal || (() => null);
  const identity = labels.identity || (() => null);
  const events = [];
  let addedCount = 0, removedCount = 0, changedCount = 0;

  for (const row of rows) {
    const data = row.rowData || {};
    const prev = row.prevData || {};
    if (row.tableName === 'ResourceAssignments') {
      const resId = data.resourceId || prev.resourceId;
      const info = resource(resId);
      const resName = info?.displayName || resId;
      const kind = resourceCounterpartyKind(info?.resourceType);
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
      const identId = data.identityId || prev.identityId;
      const label = identity(identId) || identId;
      if (row.operation === 'I') {
        addedCount++;
        events.push(toEvent(row, `Linked to identity ${label}`,
          { kind: 'identity', id: identId, label, eventKind: 'identity-member' }));
      } else if (row.operation === 'D') {
        removedCount++;
        events.push(toEvent(row, `Unlinked from identity ${label}`,
          { kind: 'identity', id: identId, label, eventKind: 'identity-member' }));
      }
    } else if (row.tableName === 'Principals') {
      // Manager change → its own relationship event (skipped by the attr diff).
      const before = prev.managerId || null;
      const after = data.managerId || null;
      if (row.operation === 'U' && before !== after) {
        const newLabel = principal(after) || after || '(none)';
        changedCount++;
        events.push(toEvent(row, after ? `Manager changed to ${newLabel}` : 'Manager removed',
          { kind: after ? 'user' : null, id: after, label: newLabel, eventKind: 'manager' }));
      }
      if (row.operation === 'U') {
        for (const c of diffPrincipalRow(prev, data)) {
          changedCount++;
          events.push({
            at: row.changedAt,
            operation: 'changed',
            eventKind: 'attribute',
            summary: `${humanizeField(c.field)}: ${c.from} → ${c.to}`,
            counterpartyKind: null,
            counterpartyId: null,
            counterpartyLabel: null,
            attribute: c,
          });
        }
      } else if (row.operation === 'I') {
        addedCount++;
        events.push(toEvent(row, 'Account created', { eventKind: 'attribute' }));
      } else if (row.operation === 'D') {
        removedCount++;
        events.push(toEvent(row, 'Account removed', { eventKind: 'attribute' }));
      }
    }
  }

  // Attribute fan-out preserves row order; re-sort the whole stream by time so
  // attribute + relationship events from different rows interleave correctly.
  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  return { events, addedCount, removedCount, changedCount };
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

// ─── /api/user/:id/timeline ──────────────────────────────────────────
// Unified, date-ranged history for the user-detail Timeline tab: attribute
// updates + relationship changes (assignments, identity links, manager) in
// one stream. Wider window than recent-changes; auth-only like its siblings.
//
// Retention note: `_history` is unbounded (migration 009 defers retention),
// so the window (sinceDays) and LIMIT bound the work; the
// ("tableName","rowId","changedAt") / ("changedAt") indexes cover the WHERE.
router.get('/user/:id/timeline', async (req, res) => {
  if (!useSql) return res.json({ sinceDays: 0, events: [], addedCount: 0, removedCount: 0, changedCount: 0 });
  const userId = req.params.id;
  if (!UUID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user id' });

  const sinceDays = clampTimelineDays(req.query.sinceDays);
  const limit = clampLimit(req.query.limit);
  try {
    const r = await db.query(`
      SELECT "tableName", operation, "changedAt", "rowData", "prevData"
        FROM "_history"
       WHERE "changedAt" > now() - ($1::int || ' days')::interval
         AND (
           ("tableName" = 'ResourceAssignments' AND "rowData"->>'principalId' = $2)
           OR ("tableName" = 'IdentityMembers'   AND "rowData"->>'principalId' = $2)
           OR ("tableName" = 'Principals'        AND "rowId" = $2)
         )
       ORDER BY "changedAt" DESC
       LIMIT $3
    `, [sinceDays, userId, limit * 2]);

    // Batch-resolve counterparty labels (avoid per-row N+1).
    const resIds = new Set(), princIds = new Set(), identIds = new Set();
    for (const row of r.rows) {
      const d = row.rowData || {}, p = row.prevData || {};
      if (row.tableName === 'ResourceAssignments') { if (d.resourceId || p.resourceId) resIds.add(d.resourceId || p.resourceId); }
      else if (row.tableName === 'IdentityMembers') { if (d.identityId || p.identityId) identIds.add(d.identityId || p.identityId); }
      else if (row.tableName === 'Principals' && row.operation === 'U') { if (d.managerId) princIds.add(d.managerId); }
    }
    const [resRows, princRows, identRows] = await Promise.all([
      resIds.size ? db.query(`SELECT id, "displayName", "resourceType" FROM "Resources" WHERE id = ANY($1)`, [[...resIds]]) : { rows: [] },
      princIds.size ? db.query(`SELECT id, "displayName" FROM "Principals" WHERE id = ANY($1)`, [[...princIds]]) : { rows: [] },
      identIds.size ? db.query(`SELECT id, "displayName" FROM "Identities" WHERE id = ANY($1)`, [[...identIds]]) : { rows: [] },
    ]);
    const resMap = new Map(resRows.rows.map(x => [x.id, { displayName: x.displayName, resourceType: x.resourceType }]));
    const princMap = new Map(princRows.rows.map(x => [x.id, x.displayName]));
    const identMap = new Map(identRows.rows.map(x => [x.id, x.displayName]));

    const built = buildUserTimeline(r.rows, {
      resource: id => resMap.get(id) || null,
      principal: id => princMap.get(id) || null,
      identity: id => identMap.get(id) || null,
    });
    built.events = built.events.slice(0, limit);
    res.json({ sinceDays, ...built });
  } catch (err) {
    console.error('user timeline failed:', err.message);
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

export default router;
