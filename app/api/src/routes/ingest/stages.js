// Staged full load — HTTP surface of ingest/stages.js.
//
//   POST   /ingest/stages                  { entity, systemId, scope?, idGeneration?, idPrefix? } → 201 { stageId }
//   POST   /ingest/stages/:id/rows         { records }                                           → 200 { rows }
//   POST   /ingest/stages/:id/finalize     { deleteMissing? }                                    → 200 { path, inserted, updated, deleted, rows }
//   POST   /ingest/stages/finalize         { stageIds, deleteMissing? }                          → 200 { results: [...] }
//   DELETE /ingest/stages/:id                                                                    → 204
//
// Records go through exactly the checks a batch on /ingest/<entity> gets —
// validation, id normalization, the extendedAttributes bounds and, for a key
// restricted to specific systems, the per-system boundary — before they reach the
// stage. See ingest/stages.js for what finalize does and why.
//
// How a crawler uses it: open one stage per (entity, system, scope) it syncs in
// full; send the scope's rows (or only its key columns, for a key sweep) in batches
// of any size; finalize them TOGETHER (POST /ingest/stages/finalize with every
// stageId of the run), with deleteMissing:true to remove what the source no longer
// has. Finalizing together is what lets a first load into an empty table take the
// fast path for the whole run rather than for its first system only. Nothing is written to the target table until finalize, and an
// abandoned stage changes nothing.

import { Router } from 'express';
import { writeSyncLog } from '../../ingest/engine.js';
import { normalizeRecords, extendedAttributesBoundsError } from '../../ingest/normalization.js';
import { restrictedSystemIds, writableCoreColumns, systemBoundaryDenial, preservedOwnerColumns } from '../../ingest/systemBoundary.js';
import { validateRecords, ENTITY_TABLE_MAP, ENTITY_KEY_MAP, ENTITY_SCOPE_MAP } from '../../ingest/validation.js';
import { crawlerHasSystemAccess, crawlerHasPermission } from '../../middleware/crawlerAuth.js';
import { openStage, getStage, appendToStage, finalizeStage, finalizeStages, abortStage, StageError } from '../../ingest/stages.js';
import { applyIngestDefaults, recoverSystemPrefix, buildScope, conflictFilterFor, discoverCoreColumns } from './helpers.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// The system-scoped entity tables a full load of which can run to millions of rows.
export const STAGEABLE = new Set(['resource-assignments', 'principals', 'resources', 'resource-relationships']);

function guard(req, res) {
  if (!useSql) { res.status(503).json({ error: 'SQL not configured' }); return false; }
  if (!crawlerHasPermission(req, 'ingest')) { res.status(403).json({ error: 'Insufficient permissions' }); return false; }
  return true;
}

function fail(res, err, what) {
  if (err instanceof StageError) return res.status(err.status).json({ error: err.message });
  console.error(`stage ${what} failed:`, err.message);
  return res.status(500).json({ error: `Stage ${what} failed: ${err.message}` });
}

const ownerOf = (req) => req.crawler?.id ?? null;

router.post('/ingest/stages', async (req, res) => {
  if (!guard(req, res)) return;
  const { entity, systemId, scope, idGeneration = 'native', idPrefix } = req.body || {};
  if (!STAGEABLE.has(entity)) {
    return res.status(400).json({ error: `entity must be one of: ${[...STAGEABLE].join(', ')}` });
  }
  if (!Number.isInteger(systemId) || systemId <= 0) return res.status(400).json({ error: 'systemId must be a positive integer' });
  if (!crawlerHasSystemAccess(req, systemId)) return res.status(403).json({ error: `Crawler does not have access to system ${systemId}` });
  try {
    const tableName = ENTITY_TABLE_MAP[entity];
    const conflictFilter = conflictFilterFor(entity);
    const stage = openStage({
      tableName, keyColumns: ENTITY_KEY_MAP[entity], systemId,
      scope: buildScope(scope, ENTITY_SCOPE_MAP[entity] || []),
      conflictFilter, scopeDeleteFilter: conflictFilter,
      preserveColumns: await preservedOwnerColumns(tableName, systemId),
      restrictSystemIds: restrictedSystemIds(req.crawler), ownerId: ownerOf(req),
    });
    Object.assign(stage, { entity, idGeneration, idPrefix });
    return res.status(201).json({ stageId: stage.id, table: tableName });
  } catch (err) {
    return fail(res, err, 'open');
  }
});

router.post('/ingest/stages/:id/rows', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const stage = getStage(req.params.id, ownerOf(req));
    if (!Array.isArray(req.body?.records)) return res.status(400).json({ error: 'records must be an array' });
    // The same defaults a batch on /ingest/<entity> gets (e.g. governed=false on
    // an assignment), so a staged row is exactly the row the batch path would write.
    const body = { records: req.body.records };
    applyIngestDefaults(stage.entity, body);
    const { records } = body;
    const check = validateRecords(records, stage.entity, stage.idGeneration, 'full');
    if (!check.valid) return res.status(400).json({ error: 'Record validation failed', details: check.errors });
    const coreColumns = writableCoreColumns(await discoverCoreColumns(stage.tableName));
    const { idPrefix, systemPrefix } = recoverSystemPrefix(stage.entity, stage.idPrefix);
    const normalized = normalizeRecords(records, coreColumns, {
      idGeneration: stage.idGeneration, idPrefix, systemPrefix, systemId: stage.systemId,
    });
    const boundsErr = extendedAttributesBoundsError(normalized);
    if (boundsErr) return res.status(400).json({ error: boundsErr });
    if (stage.restrictSystemIds) {
      const denial = await systemBoundaryDenial({
        tableName: stage.tableName, keyColumns: stage.keyColumns, records: normalized, scope: stage.scope,
        syncMode: 'full', conflictFilter: stage.conflictFilter, allowed: stage.restrictSystemIds,
      });
      if (denial) return res.status(403).json({ error: denial });
    }
    return res.json(await appendToStage(stage, normalized));
  } catch (err) {
    return fail(res, err, 'append');
  }
});

// Finalize several stages of one table together — a crawler run's systems — so the
// run gets one chance at the empty-table path instead of only its first system.
router.post('/ingest/stages/finalize', async (req, res) => {
  if (!guard(req, res)) return;
  const startTime = new Date();
  const ids = req.body?.stageIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) {
    return res.status(400).json({ error: 'stageIds must be a non-empty array (at most 1000)' });
  }
  try {
    const list = ids.map(id => getStage(String(id), ownerOf(req)));
    const results = await finalizeStages(list, { deleteMissing: req.body?.deleteMissing === true });
    for (const [i, st] of list.entries()) {
      await writeSyncLog(null, `API-stage-${st.entity}-${results[i].path}`, st.tableName, startTime,
        results[i].rows, results[i].inserted, results[i].updated, results[i].deleted, null);
    }
    return res.json({ results: list.map((st, i) => ({ stageId: st.id, ...results[i] })), durationMs: Date.now() - startTime.getTime() });
  } catch (err) {
    return fail(res, err, 'finalize');
  }
});

router.post('/ingest/stages/:id/finalize', async (req, res) => {
  if (!guard(req, res)) return;
  const startTime = new Date();
  let stage;
  try {
    stage = getStage(req.params.id, ownerOf(req));
    const result = await finalizeStage(stage, { deleteMissing: req.body?.deleteMissing === true });
    await writeSyncLog(null, `API-stage-${stage.entity}-${result.path}`, stage.tableName, startTime,
      result.rows, result.inserted, result.updated, result.deleted, null);
    return res.json({ ...result, durationMs: Date.now() - startTime.getTime() });
  } catch (err) {
    if (stage) {
      await writeSyncLog(null, `API-stage-${stage.entity}`, stage.tableName, startTime, stage.rows, 0, 0, 0, err.message).catch(() => {});
    }
    return fail(res, err, 'finalize');
  }
});

router.delete('/ingest/stages/:id', async (req, res) => {
  if (!guard(req, res)) return;
  try {
    await abortStage(getStage(req.params.id, ownerOf(req)));
    return res.status(204).end();
  } catch (err) {
    return fail(res, err, 'abort');
  }
});

export default router;
