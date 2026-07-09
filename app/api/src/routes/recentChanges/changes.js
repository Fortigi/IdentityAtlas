// Recent-changes endpoints — GET /api/{user,resources,access-package,identities}/:id/recent-changes.
//
// Per-entity "what recently moved" panels built from the _history audit table.
// Extracted verbatim from routes/recentChanges.js (audit finding C1); mounted by
// routes/recentChanges.js via router.use() so the public paths are unchanged.
// No behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql, UUID_RE, clampDays, clampLimit, toEvent, lookupResource, lookupIdentity, lookupPrincipal, resourceCounterpartyKind } from './shared.js';

const router = Router();

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
              AND "rowData"->>'resourceId' = $2)
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


export default router;
