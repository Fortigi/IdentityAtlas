// Entity Diff endpoints — GET /api/{user,resources,access-package,identities,contexts}/:id/diff?at=<ISO>
//
// Returns the entity as it was at `at` and as it is now, as two snapshots
// (see snapshot.js for the shape and how the past is rebuilt from _history).
// The UI diffs the two side by side.
//
// Cost: one lookup per relationship source on _history, each served by the
// per-column partial indexes from migration 055 (plus the rowId index for the
// entity's own row). Unchanged relationship rows are read from the live table
// and capped at UNCHANGED_CAP per source; the rest are counted, not listed.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { useSql, UUID_RE } from './shared.js';
import { resolveTimelineLabels } from './timeline.js';
import { RELATIONSHIP_SOURCES, ENTITY_TABLE, rowAt, buildDiffSnapshots } from './snapshot.js';

const router = Router();

export const UNCHANGED_CAP = 2000;

// `at` must be a valid moment in the past. Returns a Date or null.
export function parseAt(value) {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() > Date.now()) return null;
  return d;
}

// First change after T of the entity's own row → its state at T.
async function loadEntityRows(table, id, at) {
  const [cur, first] = await Promise.all([
    db.queryOne(`SELECT to_jsonb(t) AS "row" FROM "${table}" t WHERE t.id = $1`, [id]),
    db.queryOne(`
      SELECT operation, "prevData" FROM "_history"
       WHERE "tableName" = $1 AND "rowId" = $2 AND "changedAt" > $3
       ORDER BY "changedAt" ASC, id ASC
       LIMIT 1`, [table, id, at]),
  ]);
  const nowRow = cur?.row ?? null;
  return { nowRow, thenRow: rowAt(first, nowRow), found: !!(nowRow || first) };
}

// One relationship source: its rows changed since T (first + last change per
// row) and its rows present now. `table`/`column` come from the constant
// source list in snapshot.js, never from the request.
async function loadSource(source, id, at) {
  const { table, column, softDelete } = source;
  const changed = await db.query(`
    WITH h AS (
      SELECT id, "rowId", operation, "rowData", "prevData", "changedAt"
        FROM "_history"
       WHERE "tableName" = '${table}' AND "rowData"->>'${column}' = $1 AND "changedAt" > $2
    ), f AS (
      SELECT DISTINCT ON ("rowId") "rowId", operation, "prevData" FROM h ORDER BY "rowId", "changedAt", id
    ), l AS (
      SELECT DISTINCT ON ("rowId") "rowId", operation, "rowData" FROM h ORDER BY "rowId", "changedAt" DESC, id DESC
    )
    SELECT f."rowId", f.operation AS "firstOp", f."prevData" AS "firstPrev",
           l.operation AS "lastOp", l."rowData" AS "lastData"
      FROM f JOIN l USING ("rowId")`, [id, at]);
  const changes = changed.rows;
  const current = await db.query(`
    SELECT to_jsonb(t) AS "row", count(*) OVER () AS total
      FROM "${table}" t
     WHERE t."${column}" = $1 ${softDelete ? 'AND t."deletedAt" IS NULL' : ''}
     LIMIT $2`, [id, UNCHANGED_CAP + changes.length]);
  return {
    source,
    changes,
    current: current.rows.map(r => r.row),
    total: Number(current.rows[0]?.total || 0),
  };
}

// Rows in the shape resolveTimelineLabels expects, covering both snapshots.
function labelRows(table, thenRow, nowRow, sources) {
  const rows = [{ tableName: table, rowData: nowRow, prevData: thenRow }];
  for (const s of sources) {
    for (const c of s.changes) rows.push({ tableName: s.source.table, rowData: c.lastData, prevData: c.firstPrev });
    for (const r of s.current) rows.push({ tableName: s.source.table, rowData: r, prevData: null });
  }
  return rows;
}

export function diffHandler(entityKind) {
  return async (req, res) => {
    if (!useSql) return res.json({ at: null, before: null, after: null, omittedUnchanged: 0 });
    const id = req.params.id;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
    const at = parseAt(req.query.at);
    if (!at) return res.status(400).json({ error: 'at must be a valid date in the past' });
    const table = ENTITY_TABLE[entityKind];
    try {
      const [entity, historySince, ...sources] = await Promise.all([
        loadEntityRows(table, id, at),
        db.queryOne(`SELECT min("changedAt") AS since FROM "_history"`),
        ...RELATIONSHIP_SOURCES[entityKind].map(s => loadSource(s, id, at)),
      ]);
      if (!entity.found) return res.status(404).json({ error: 'Not found' });
      const labels = await resolveTimelineLabels(labelRows(table, entity.thenRow, entity.nowRow, sources));
      const built = buildDiffSnapshots({ thenRow: entity.thenRow, nowRow: entity.nowRow, sources, labels });
      res.json({
        at: at.toISOString(),
        historySince: historySince?.since ?? null,
        relationshipsTracked: RELATIONSHIP_SOURCES[entityKind].length > 0,
        ...built,
      });
    } catch (err) {
      console.error(`${entityKind} diff failed:`, err.message);
      res.status(500).json({ error: 'Failed to load diff' });
    }
  };
}

router.get('/user/:id/diff', diffHandler('user'));
router.get('/resources/:id/diff', diffHandler('resource'));
router.get('/access-package/:id/diff', diffHandler('access-package'));
router.get('/identities/:id/diff', diffHandler('identity'));
router.get('/contexts/:id/diff', diffHandler('context'));

export default router;
