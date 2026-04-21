// Plugin runner.
//
// Orchestrates a single ContextAlgorithmRuns row:
//   1. queue the run
//   2. call plugin.run(params)
//   3. reconcile the produced contexts + members with the database
//   4. update the run row with counts + status
//
// Reconciliation rules:
//   - Match contexts on (sourceAlgorithmId, scopeSystemId, externalId).
//   - Contexts in the plugin output that don't exist yet get INSERT.
//   - Existing contexts that still appear in the output get UPDATE.
//   - Contexts previously produced by this (algorithm, scope) that are NOT
//     in the new output get DELETE. Manual children grafted under a
//     generated parent survive — the FK is ON DELETE CASCADE on parent, so
//     we only delete rows we own (variant='generated').
//   - Members with addedBy='algorithm' are fully replaced by the new set
//     for contexts we own. Members with addedBy='analyst' or 'sync' survive.

import * as db from '../../db/connection.js';
import { randomUUID } from 'crypto';
import { getPlugin } from './registry.js';

export async function enqueueRun(pluginName, params, triggeredBy) {
  const plugin = getPlugin(pluginName);
  if (!plugin) throw new Error(`Unknown plugin: ${pluginName}`);

  const algoRow = await db.queryOne(
    `SELECT id FROM "ContextAlgorithms" WHERE name = $1`,
    [plugin.name]
  );
  if (!algoRow) throw new Error(`Plugin ${pluginName} is not registered in ContextAlgorithms. Has seedAlgorithms run?`);

  validateParams(plugin, params);

  const runId = randomUUID();
  const scopeSystemId = params.scopeSystemId ? parseInt(params.scopeSystemId, 10) : null;

  await db.query(`
    INSERT INTO "ContextAlgorithmRuns"
      (id, "algorithmId", parameters, "scopeSystemId", status, "triggeredBy")
    VALUES ($1, $2, $3, $4, 'queued', $5)
  `, [runId, algoRow.id, params, scopeSystemId, triggeredBy || null]);

  // Fire-and-forget async execution. The run row is the only persisted state.
  setImmediate(() => {
    executeRun(runId, plugin, algoRow.id, params).catch(err => {
      console.error(`[context-plugin] ${pluginName} run ${runId} crashed:`, err);
    });
  });

  return runId;
}

export async function dryRun(pluginName, params) {
  const plugin = getPlugin(pluginName);
  if (!plugin) throw new Error(`Unknown plugin: ${pluginName}`);
  validateParams(plugin, params);

  const result = await plugin.run(params, { db, runId: null, log: () => {} });
  return {
    contextCount: result.contexts.length,
    memberCount:  result.members.length,
    samples: {
      contexts: result.contexts.slice(0, 10),
      members:  result.members.slice(0, 10),
    },
  };
}

export async function getRun(runId) {
  return db.queryOne(`
    SELECT r.*, a.name AS "algorithmName", a."displayName" AS "algorithmDisplayName", a."targetType"
      FROM "ContextAlgorithmRuns" r
      JOIN "ContextAlgorithms" a ON r."algorithmId" = a.id
     WHERE r.id = $1
  `, [runId]);
}

export async function listRuns({ algorithmId = null, limit = 50 } = {}) {
  const params = [];
  const clauses = [];
  if (algorithmId) { params.push(algorithmId); clauses.push(`r."algorithmId" = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200));
  const r = await db.query(`
    SELECT r.*, a.name AS "algorithmName", a."displayName" AS "algorithmDisplayName", a."targetType"
      FROM "ContextAlgorithmRuns" r
      JOIN "ContextAlgorithms" a ON r."algorithmId" = a.id
     ${where}
     ORDER BY r."startedAt" DESC
     LIMIT $${params.length}
  `, params);
  return r.rows;
}

// ─── Internal ────────────────────────────────────────────────────────

function validateParams(plugin, params) {
  // Lightweight required-field enforcement. We don't do full JSON Schema —
  // the plugin itself will throw for malformed input.
  for (const req of (plugin.parametersSchema?.required || [])) {
    if (params[req] === undefined || params[req] === null || params[req] === '') {
      throw new Error(`Missing required parameter: ${req}`);
    }
  }
}

async function executeRun(runId, plugin, algorithmId, params) {
  await db.query(`UPDATE "ContextAlgorithmRuns" SET status = 'running' WHERE id = $1`, [runId]);

  try {
    const result = await plugin.run(params, { db, runId, log: (msg) => console.log(`[context-plugin ${runId}] ${msg}`) });
    const counts = await reconcile(plugin, algorithmId, runId, params, result);

    await db.query(`
      UPDATE "ContextAlgorithmRuns"
         SET status = 'succeeded',
             "finishedAt" = now() AT TIME ZONE 'utc',
             "contextsCreated" = $2,
             "contextsUpdated" = $3,
             "contextsRemoved" = $4,
             "membersAdded" = $5,
             "membersRemoved" = $6
       WHERE id = $1
    `, [runId, counts.contextsCreated, counts.contextsUpdated, counts.contextsRemoved, counts.membersAdded, counts.membersRemoved]);
  } catch (err) {
    console.error(`[context-plugin] ${plugin.name} failed:`, err);
    await db.query(`
      UPDATE "ContextAlgorithmRuns"
         SET status = 'failed',
             "finishedAt" = now() AT TIME ZONE 'utc',
             "errorMessage" = $2
       WHERE id = $1
    `, [runId, (err.message || String(err)).slice(0, 2000)]);
  }
}

async function reconcile(plugin, algorithmId, runId, params, result) {
  const scopeSystemId = params.scopeSystemId ? parseInt(params.scopeSystemId, 10) : null;
  const counts = { contextsCreated: 0, contextsUpdated: 0, contextsRemoved: 0, membersAdded: 0, membersRemoved: 0 };

  await db.tx(async (client) => {
    // 1) Pre-load existing contexts for (algorithmId, scopeSystemId) so we
    //    can tell insert / update / delete apart.
    const existingRows = (await client.query(`
      SELECT id, "externalId" FROM "Contexts"
       WHERE "sourceAlgorithmId" = $1 AND ($2::int IS NULL OR "scopeSystemId" = $2)
    `, [algorithmId, scopeSystemId])).rows;
    const existingByExternalId = new Map(existingRows.map(r => [r.externalId, r.id]));

    // 2) Build a map externalId -> new parentContextId once we know our own
    //    generated ids. We need two passes because parents may appear after
    //    children in the plugin's output.
    const newByExternalId = new Map();  // externalId -> UUID (final Contexts.id)
    for (const node of result.contexts) {
      if (!node.externalId) continue;
      const existingId = existingByExternalId.get(node.externalId);
      newByExternalId.set(node.externalId, existingId || randomUUID());
    }

    // 3) Upsert contexts — two passes to avoid FK-ordering pain.
    //    Plugins emit contexts in arbitrary order, and manager-hierarchy in
    //    particular iterates a Set of managerIds; a child may land before
    //    its parent. Rather than topologically sort, we:
    //      3a) INSERT/UPDATE every node with parentContextId = NULL.
    //      3b) UPDATE every node with a real parent pointer in one pass.
    //    The existing "Contexts_parentContextId_fkey" FK is not deferrable,
    //    so this two-pass form is the simplest way to stay legal.

    // 3a) First pass: all rows with parent = NULL.
    for (const node of result.contexts) {
      if (!node.externalId) continue;
      const id = newByExternalId.get(node.externalId);
      const existed  = existingByExternalId.has(node.externalId);

      if (existed) {
        await client.query(`
          UPDATE "Contexts"
             SET "displayName"         = $2,
                 description           = $3,
                 "contextType"         = $4,
                 "parentContextId"     = NULL,
                 "extendedAttributes"  = $5,
                 "sourceRunId"         = $6
           WHERE id = $1
        `, [id, node.displayName, node.description || null, node.contextType || plugin.name, node.extendedAttributes || null, runId]);
        counts.contextsUpdated++;
      } else {
        await client.query(`
          INSERT INTO "Contexts"
            (id, variant, "targetType", "contextType", "displayName", description,
             "parentContextId", "scopeSystemId", "sourceAlgorithmId", "sourceRunId", "externalId", "extendedAttributes")
          VALUES ($1, 'generated', $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10)
        `, [id, plugin.targetType, node.contextType || plugin.name, node.displayName, node.description || null,
            scopeSystemId, algorithmId, runId, node.externalId, node.extendedAttributes || null]);
        counts.contextsCreated++;
      }
    }

    // 3b) Second pass: set parent pointers now that every target row exists.
    for (const node of result.contexts) {
      if (!node.externalId || !node.parentExternalId) continue;
      const id = newByExternalId.get(node.externalId);
      const parentId = newByExternalId.get(node.parentExternalId);
      if (!parentId) continue; // parent wasn't in the output — leave NULL
      await client.query(
        `UPDATE "Contexts" SET "parentContextId" = $2 WHERE id = $1`,
        [id, parentId]
      );
    }

    // 4) Remove contexts that previously belonged to this (algorithm, scope)
    //    but are no longer in the plugin's output.
    const producedExternalIds = new Set(result.contexts.map(n => n.externalId));
    const stale = existingRows.filter(r => !producedExternalIds.has(r.externalId)).map(r => r.id);
    if (stale.length > 0) {
      await client.query(`DELETE FROM "Contexts" WHERE id = ANY($1::uuid[])`, [stale]);
      counts.contextsRemoved = stale.length;
    }

    // 5) Members — we own rows with addedBy='algorithm' for contexts in
    //    `producedContextIds`. Wipe and re-insert.
    const producedContextIds = [...newByExternalId.values()];
    if (producedContextIds.length > 0) {
      const del = await client.query(`
        DELETE FROM "ContextMembers"
         WHERE "contextId" = ANY($1::uuid[]) AND "addedBy" = 'algorithm'
      `, [producedContextIds]);
      counts.membersRemoved = del.rowCount || 0;

      // Insert in batches to avoid absurd parameter counts on huge runs.
      let insertedNow = 0;
      const BATCH = 500;
      for (let i = 0; i < result.members.length; i += BATCH) {
        const slice = result.members.slice(i, i + BATCH);
        const values = [];
        const params = [];
        let placeholderIdx = 0;
        for (const m of slice) {
          const ctxId = newByExternalId.get(m.contextExternalId);
          if (!ctxId) continue; // dangling reference — skip silently
          params.push(ctxId, plugin.targetType, m.memberId);
          values.push(`($${placeholderIdx + 1}, $${placeholderIdx + 2}, $${placeholderIdx + 3}, 'algorithm')`);
          placeholderIdx += 3;
        }
        if (values.length === 0) continue;
        const r = await client.query(`
          INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
          VALUES ${values.join(', ')}
          ON CONFLICT ("contextId", "memberId") DO NOTHING
        `, params);
        insertedNow += r.rowCount || 0;
      }
      counts.membersAdded = insertedNow;
    }

    // 6) Refresh directMemberCount on every context we touched.
    if (producedContextIds.length > 0) {
      await client.query(`
        UPDATE "Contexts" c
           SET "directMemberCount" = COALESCE(m.cnt, 0),
               "lastCalculatedAt"  = now() AT TIME ZONE 'utc'
          FROM (
            SELECT "contextId", COUNT(*)::int AS cnt
              FROM "ContextMembers"
             WHERE "contextId" = ANY($1::uuid[])
             GROUP BY "contextId"
          ) m
         WHERE c.id = m."contextId"
      `, [producedContextIds]);
    }
  });

  return counts;
}
