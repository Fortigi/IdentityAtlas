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
import { wouldCreateCycle } from '../cycleGuard.js';

// Second pass of reconcile: set parent pointers now that every target row exists.
// Skips analyst-reparented nodes and unresolved parents, and — via wouldCreateCycle
// — any link that would close a loop against the tree written so far this pass
// (client sees the in-transaction rows), leaving that node a root rather than
// writing it. Extracted from reconcile to keep it under the complexity ceiling.
// Migration 059's deferred trigger is the backstop: a cycle that somehow survived
// to commit aborts the run's transaction (surfaced as a failed run) rather than
// being silently NULLed by a post-hoc repair (#627).
async function linkContextParents(client, contexts, newByExternalId, reparentedIds, pluginName) {
  for (const node of contexts) {
    if (!node.externalId || !node.parentExternalId) continue;
    const id = newByExternalId.get(node.externalId);
    if (reparentedIds.has(id)) continue; // analyst moved this node — keep their placement
    const parentId = newByExternalId.get(node.parentExternalId);
    if (!parentId) continue; // parent wasn't in the output — leave NULL
    if (await wouldCreateCycle(client, id, parentId)) {
      console.warn(`[context-plugin] ${pluginName}: skipped cyclic parent ${node.parentExternalId} -> ${node.externalId}`);
      continue;
    }
    await client.query(
      `UPDATE "Contexts" SET "parentContextId" = $2 WHERE id = $1`,
      [id, parentId]
    );
  }
}

export async function enqueueRun(pluginName, params, triggeredBy, opts = {}) {
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
  // Each run targets a tree "instance". A caller that passes an existing
  // instanceKey refreshes that tree in place (keeping analyst edits); with no
  // key we mint a fresh one, so the run produces a brand-new, independent tree.
  const instanceKey = (typeof params.instanceKey === 'string' && params.instanceKey.trim())
    ? params.instanceKey.trim()
    : randomUUID();

  await db.query(`
    INSERT INTO "ContextAlgorithmRuns"
      (id, "algorithmId", parameters, "scopeSystemId", status, "triggeredBy")
    VALUES ($1, $2, $3, $4, 'queued', $5)
  `, [runId, algoRow.id, params, scopeSystemId, triggeredBy || null]);

  // Fire-and-forget async execution by default. The run row is the only persisted
  // state. The post-crawl pipeline passes awaitCompletion to run jobs in order.
  if (opts.awaitCompletion) {
    try { await executeRun(runId, plugin, algoRow.id, params, instanceKey); }
    catch (err) { console.error(`[context-plugin] ${pluginName} run ${runId} crashed:`, err); }
  } else {
    setImmediate(() => {
      executeRun(runId, plugin, algoRow.id, params, instanceKey).catch(err => {
        console.error(`[context-plugin] ${pluginName} run ${runId} crashed:`, err);
      });
    });
  }

  return runId;
}

// Re-run every generated context tree against current data. Called after a crawl
// so plugin-derived contexts (Managed Identities, Resource Types, scope trees…)
// never go stale — they're derived data, so a crawl is exactly when they should
// refresh (this removes any need for separate per-plugin scheduling). Each tree
// is re-run with its original parameters + instanceKey, so reconcile updates it
// in place (no duplicates, analyst edits preserved). Opt a tree out by setting
// its run parameters' `autoRefresh` to false.
export async function refreshGeneratedContexts(triggeredBy = 'crawl-refresh', { awaitCompletion = false } = {}) {
  const trees = (await db.query(`
    SELECT a.name AS algo,
           c."sourceAlgorithmId" AS "algorithmId",
           c."scopeSystemId" AS "scopeSystemId",
           c."sourceInstanceKey" AS ikey,
           (array_agg(r.parameters ORDER BY c."createdAt" DESC))[1] AS params
      FROM "Contexts" c
      JOIN "ContextAlgorithms" a ON a.id = c."sourceAlgorithmId"
      LEFT JOIN "ContextAlgorithmRuns" r ON r.id = c."sourceRunId"
     WHERE c.variant = 'generated' AND c."sourceAlgorithmId" IS NOT NULL
     GROUP BY a.name, c."sourceAlgorithmId", c."scopeSystemId", c."sourceInstanceKey"
  `)).rows;

  let started = 0;
  for (const t of trees) {
    if (!t.params) continue;                       // no recoverable parameters
    if (t.params.autoRefresh === false) continue;  // opted out
    try {
      // Legacy trees (created before migration 034) have a NULL instance key.
      // Passing `undefined` to enqueueRun would make it mint a fresh random key
      // every crawl — reconcile then matches nothing and inserts a brand-new
      // duplicate tree each run (the "explode" bug). Backfill a stable key onto
      // the existing tree first (same as the manual /sync path), so the refresh
      // reconciles onto it in place instead of spawning a copy.
      let ikey = t.ikey;
      if (!ikey) {
        ikey = randomUUID();
        await db.query(`
          UPDATE "Contexts" SET "sourceInstanceKey" = $1
           WHERE "sourceAlgorithmId" = $2
             AND ($3::int IS NULL OR "scopeSystemId" = $3)
             AND "sourceInstanceKey" IS NULL
        `, [ikey, t.algorithmId, t.scopeSystemId]);
      }
      await enqueueRun(t.algo, { ...t.params, instanceKey: ikey }, triggeredBy, { awaitCompletion });
      started++;
    } catch (err) {
      console.error(`[context-refresh] ${t.algo} (${t.ikey || 'no-key'}) failed:`, err.message);
    }
  }
  if (started) console.log(`[context-refresh] refreshing ${started} generated context tree(s) after ${triggeredBy}`);
  return started;
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

async function executeRun(runId, plugin, algorithmId, params, instanceKey) {
  await db.query(`UPDATE "ContextAlgorithmRuns" SET status = 'running' WHERE id = $1`, [runId]);

  try {
    const result = await plugin.run(params, { db, runId, log: (msg) => console.log(`[context-plugin ${runId}] ${msg}`) });
    const counts = await reconcile(plugin, algorithmId, runId, params, result, instanceKey);

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

async function reconcile(plugin, algorithmId, runId, params, result, instanceKey = '') {
  const scopeSystemId = params.scopeSystemId ? parseInt(params.scopeSystemId, 10) : null;
  const counts = { contextsCreated: 0, contextsUpdated: 0, contextsRemoved: 0, membersAdded: 0, membersRemoved: 0 };

  await db.tx(async (client) => {
    // 1) Pre-load existing contexts for this (algorithm, scope, instance) so we
    //    can tell insert / update / delete apart. Scoping by instance is what
    //    lets several trees from the same plugin coexist on one system — a run
    //    only ever touches its own tree.
    const existingRows = (await client.query(`
      SELECT id, "externalId", "userReparented" FROM "Contexts"
       WHERE "sourceAlgorithmId" = $1 AND ($2::int IS NULL OR "scopeSystemId" = $2)
         AND COALESCE("sourceInstanceKey", '') = $3
    `, [algorithmId, scopeSystemId, instanceKey])).rows;
    const existingByExternalId = new Map(existingRows.map(r => [r.externalId, r.id]));
    // Ids the analyst has manually re-parented — the runner must not move them
    // back. (Renames are preserved by the UPDATE's CASE on "userRenamed".)
    const reparentedIds = new Set(existingRows.filter(r => r.userReparented).map(r => r.id));

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
        // Preserve analyst curation: keep the renamed displayName when
        // "userRenamed", and don't reset the parent to NULL when
        // "userReparented" (the 3b pass also skips those nodes). Un-edited
        // nodes are refreshed from the plugin output as before.
        await client.query(`
          UPDATE "Contexts"
             SET "displayName"         = CASE WHEN "userRenamed"    THEN "displayName"     ELSE $2 END,
                 description           = $3,
                 "contextType"         = $4,
                 "parentContextId"     = CASE WHEN "userReparented" THEN "parentContextId" ELSE NULL END,
                 "extendedAttributes"  = $5,
                 "sourceRunId"         = $6
           WHERE id = $1
        `, [id, node.displayName, node.description || null, node.contextType || plugin.name, node.extendedAttributes || null, runId]);
        counts.contextsUpdated++;
      } else {
        await client.query(`
          INSERT INTO "Contexts"
            (id, variant, "targetType", "contextType", "displayName", description,
             "parentContextId", "scopeSystemId", "sourceAlgorithmId", "sourceRunId", "externalId", "extendedAttributes", "sourceInstanceKey")
          VALUES ($1, 'generated', $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, $11)
        `, [id, plugin.targetType, node.contextType || plugin.name, node.displayName, node.description || null,
            scopeSystemId, algorithmId, runId, node.externalId, node.extendedAttributes || null, instanceKey]);
        counts.contextsCreated++;
      }
    }

    // 3b) Second pass: set parent pointers now that every target row exists.
    await linkContextParents(client, result.contexts, newByExternalId, reparentedIds, plugin.name);

    // Acyclicity is handled up front by linkContextParents (it skips a loop-closing
    // link, leaving the node a root) and guaranteed by migration 059's deferred
    // trigger at commit; the member-count roll-up below is itself CYCLE-guarded, so
    // it can't hang. No post-hoc repair needed (#627).

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

    // 6a) Refresh directMemberCount on every context we touched.
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

      // 6b) Roll up totalMemberCount = sum of directMemberCount over the
      //     subtree rooted at each context. We count distinct members so a
      //     person who's a direct member of two sibling leaves in the same
      //     tree doesn't get counted twice (uncommon but possible).
      await client.query(`
        WITH RECURSIVE subtree AS (
          -- Seed: the context itself.
          SELECT id AS root_id, id AS node_id
            FROM "Contexts"
           WHERE id = ANY($1::uuid[])
          UNION
          -- Walk down.
          SELECT s.root_id, c.id
            FROM "Contexts" c
            JOIN subtree s ON c."parentContextId" = s.node_id
        ),
        totals AS (
          SELECT s.root_id, COUNT(DISTINCT cm."memberId")::int AS cnt
            FROM subtree s
            LEFT JOIN "ContextMembers" cm ON cm."contextId" = s.node_id
           GROUP BY s.root_id
        )
        UPDATE "Contexts" c
           SET "totalMemberCount" = t.cnt
          FROM totals t
         WHERE c.id = t.root_id
      `, [producedContextIds]);
    }
  });

  return counts;
}
