// Point-in-time reconstruction of matrix scope statistics from the `_history`
// audit log — no dedicated snapshot tables.
//
// HOW IT WORKS
// ------------
// `_history` (migrations 009 / 022) stores one row per change (INSERT / UPDATE /
// DELETE) to the tracked tables, each carrying a full JSONB snapshot of the row
// (`rowData`) and the previous state (`prevData`), stamped with `changedAt`.
//
// The state of any row as-of a past instant D is:
//
//   • the `prevData` of the EARLIEST history event for that row with
//     changedAt > D  — that event transformed the row's state-at-D into its
//     next state, so its `prevData` *is* the state at D (NULL prevData ⇒ the
//     event was an INSERT ⇒ the row did not exist at D); OR
//   • if the row has no event after D, its CURRENT live row — it hasn't changed
//     since D, so current state == state at D.
//
// The union of those two branches is the exact set of rows alive at D, with
// their attributes as they were at D. This needs only `_history` + the live
// tables. Accuracy extends back to when audit triggers were first attached;
// before that boundary the reconstruction is unreliable, so callers expose a
// `historyStart` and avoid plotting earlier points.
//
// LIMITATION: ContextMembers is intentionally NOT audited, so context-membership
// scope conditions fall back to *current* membership (flagged scopeMode
// 'context-current'). Attribute conditions (e.g. department) reconstruct fully.

import { UUID_RE, collectContextIds } from './filterSql.js';

const SAFE_IDENT_RE = /^[a-zA-Z0-9_]+$/;
const EXT_PREFIX = 'ext.';
const GROUP_TYPE = '#microsoft.graph.group';

// ── Sample dates ─────────────────────────────────────────────────────
// Evenly-spaced UTC dates (ascending, inclusive of today), used as the
// reconstruction instants for the timeline. Times are end-of-day UTC so a
// point labelled 2026-01-15 reflects state at the close of that day.
export function generateSampleDates({ days = 180, points = 13 } = {}) {
  const d = Math.min(Math.max(parseInt(days, 10) || 180, 1), 1095);
  const n = Math.min(Math.max(parseInt(points, 10) || 13, 2), 60);
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const dayMs = 86_400_000;
  const out = [];
  for (let i = 0; i < n; i++) {
    // oldest → newest
    const offsetDays = Math.round((d * (n - 1 - i)) / (n - 1));
    out.push(new Date(todayUtc - offsetDays * dayMs).toISOString().slice(0, 10));
  }
  // de-dup (small ranges with many points can collide)
  return [...new Set(out)];
}

// ── As-of CTE builders ───────────────────────────────────────────────

// Alive rows of a surrogate-id table at @asof, as (key text, state jsonb).
function asofSurrogateCte(name, table, tableName) {
  return `${name} AS (
    SELECT x."rowId" AS key, x."prevData" AS state FROM (
      SELECT h."rowId", h."prevData",
             ROW_NUMBER() OVER (PARTITION BY h."rowId" ORDER BY h."changedAt" ASC) AS rn
        FROM "_history" h
       WHERE h."tableName" = '${tableName}' AND h."changedAt" > @asof
    ) x
     WHERE x.rn = 1 AND x."prevData" IS NOT NULL
    UNION ALL
    SELECT t.id::text AS key, to_jsonb(t) AS state
      FROM "${table}" t
     WHERE NOT EXISTS (
       SELECT 1 FROM "_history" h
        WHERE h."tableName" = '${tableName}' AND h."rowId" = t.id::text
          AND h."changedAt" > @asof)
  )`;
}

// Alive ResourceAssignments at @asof, as (rid, pid, atype). Composite key:
// resourceId|principalId|assignmentType (see migration 022).
function asofAssignmentsCte(name) {
  return `${name} AS (
    SELECT (s->>'resourceId') AS rid, (s->>'principalId') AS pid, (s->>'assignmentType') AS atype
      FROM (
        SELECT x."prevData" AS s FROM (
          SELECT h."prevData",
                 ROW_NUMBER() OVER (PARTITION BY h."rowId" ORDER BY h."changedAt" ASC) AS rn
            FROM "_history" h
           WHERE h."tableName" = 'ResourceAssignments' AND h."changedAt" > @asof
        ) x
         WHERE x.rn = 1 AND x."prevData" IS NOT NULL
      ) hist
    UNION ALL
    SELECT ra."resourceId"::text, ra."principalId"::text, ra."assignmentType"
      FROM "ResourceAssignments" ra
     WHERE NOT EXISTS (
       SELECT 1 FROM "_history" h
        WHERE h."tableName" = 'ResourceAssignments'
          AND h."rowId" = ra."resourceId"::text || '|' || ra."principalId"::text || '|' || ra."assignmentType"
          AND h."changedAt" > @asof)
  )`;
}

// Alive 'Contains' ResourceRelationships at @asof, as (parent, child). Composite
// key: parentResourceId|childResourceId|relationshipType (see migration 022).
function asofContainsCte(name) {
  return `${name} AS (
    SELECT (s->>'parentResourceId') AS parent, (s->>'childResourceId') AS child
      FROM (
        SELECT x."prevData" AS s FROM (
          SELECT h."prevData",
                 ROW_NUMBER() OVER (PARTITION BY h."rowId" ORDER BY h."changedAt" ASC) AS rn
            FROM "_history" h
           WHERE h."tableName" = 'ResourceRelationships' AND h."changedAt" > @asof
        ) x
         WHERE x.rn = 1 AND x."prevData" IS NOT NULL
      ) hist
     WHERE (s->>'relationshipType') = 'Contains'
    UNION ALL
    SELECT rr."parentResourceId"::text, rr."childResourceId"::text
      FROM "ResourceRelationships" rr
     WHERE rr."relationshipType" = 'Contains'
       AND NOT EXISTS (
         SELECT 1 FROM "_history" h
          WHERE h."tableName" = 'ResourceRelationships'
            AND h."rowId" = rr."parentResourceId"::text || '|' || rr."childResourceId"::text || '|' || rr."relationshipType"
            AND h."changedAt" > @asof)
  )`;
}

// ── Scope condition clauses (evaluated against an as-of `state` jsonb) ──

function attributeClause(stateAlias, field, values, validColumns, bindings, prefix, slot) {
  if (typeof field !== 'string') return null;
  if (!Array.isArray(values)) return null;
  const vals = values.filter(v => v != null && v !== '').map(String).slice(0, 200);
  if (vals.length === 0) return null;

  const ph = vals.map((v, i) => { const p = `${prefix}_${slot}_${i}`; bindings[p] = v; return `@${p}`; });

  if (field.startsWith(EXT_PREFIX)) {
    const key = field.slice(EXT_PREFIX.length);
    if (!SAFE_IDENT_RE.test(key)) return null;
    return `(${stateAlias}->'extendedAttributes'->>'${key}') IN (${ph.join(',')})`;
  }
  if (!SAFE_IDENT_RE.test(field)) return null;
  if (validColumns && !validColumns.has(field)) return null;
  return `(${stateAlias}->>'${field}') IN (${ph.join(',')})`;
}

// Context membership — CURRENT membership only (ContextMembers is not audited).
// Mirrors filterSql.buildContextClause but matches the as-of row id (state->>'id').
function contextClause({ entity, stateAlias, contextId, includeChildren, ctxType, bindings, prefix, slot }) {
  if (!UUID_RE.test(contextId || '')) return null;
  if (!ctxType) return null;
  const idP = `${prefix}_${slot}_id`; bindings[idP] = contextId;
  const mtP = `${prefix}_${slot}_mt`; bindings[mtP] = ctxType;

  const members = includeChildren
    ? `(WITH RECURSIVE scope AS (
          SELECT id FROM "Contexts" WHERE id = @${idP}
          UNION ALL
          SELECT c.id FROM "Contexts" c JOIN scope ON c."parentContextId" = scope.id)
        SELECT "memberId" FROM "ContextMembers"
         WHERE "memberType" = @${mtP} AND "contextId" IN (SELECT id FROM scope))`
    : `(SELECT "memberId" FROM "ContextMembers"
         WHERE "memberType" = @${mtP} AND "contextId" = @${idP})`;

  const idExpr = `(${stateAlias}->>'id')`;
  if (ctxType === entity) return `${idExpr}::uuid IN ${members}`;
  if (entity === 'Principal' && ctxType === 'Identity')
    return `${idExpr}::uuid IN (SELECT "principalId" FROM "IdentityMembers" WHERE "identityId" IN ${members})`;
  if (entity === 'Resource' && ctxType === 'System')
    return `(${stateAlias}->>'systemId') IN ${members}`;
  return null;
}

// Build the WHERE fragment (include AND, exclude AS NOT TRUE) for one entity
// block, against the as-of `state` alias. Returns { where, usedContext }.
function scopeWhere({ entity, stateAlias, block, validColumns, contextTypes, bindings, prefix, warnings }) {
  const inc = [];
  const exc = [];
  let usedContext = false;

  const handle = (conds, target) => {
    if (!Array.isArray(conds)) return;
    conds.forEach((cond, idx) => {
      if (!cond || typeof cond !== 'object') return;
      const slot = `${target}_${idx}`;
      let clause = null;
      if (cond.kind === 'context') {
        usedContext = true;
        clause = contextClause({
          entity, stateAlias, contextId: cond.contextId,
          includeChildren: !!cond.includeChildren,
          ctxType: contextTypes.get(cond.contextId),
          bindings, prefix, slot,
        });
        if (!clause) { warnings.push(`history: context condition dropped (${cond.contextId})`); return; }
      } else if (cond.kind === 'attribute') {
        clause = attributeClause(stateAlias, cond.field, cond.values, validColumns, bindings, prefix, slot);
        if (!clause) { warnings.push(`history: attribute condition dropped (${cond.field})`); return; }
      } else {
        warnings.push(`history: unknown condition kind ${cond.kind}`);
        return;
      }
      (target === 'inc' ? inc : exc).push(clause);
    });
  };
  handle(block?.include, 'inc');
  handle(block?.exclude, 'exc');

  const parts = [...inc, ...exc.map(c => `(${c}) IS NOT TRUE`)];
  return { where: parts.length ? parts.join(' AND ') : null, usedContext };
}

// ── Public: build the per-date reconstruction query ──────────────────
// Returns { sql, bindings, warnings, scopeMode }. `sql` reconstructs scope
// metrics for a single instant bound to the `@asof` parameter; run it once per
// sample date (varying only @asof).
export function buildScopeAsofSql({ filter, principalColSet, resourceColSet, contextTypes }) {
  const bindings = {};
  const warnings = [];
  const isIdentity = filter.rowType === 'identity';

  // Subject scope — reconstructed alive principals matching subject conditions.
  const subj = scopeWhere({
    entity: 'Principal', stateAlias: 'sp.state', block: filter.subject,
    validColumns: principalColSet, contextTypes, bindings, prefix: 'h_sf', warnings,
  });
  const res = scopeWhere({
    entity: 'Resource', stateAlias: 'sr.state', block: filter.resource,
    validColumns: resourceColSet, contextTypes, bindings, prefix: 'h_rf', warnings,
  });

  const principalWhere = [
    `(sp.state->>'principalType' IS NULL OR sp.state->>'principalType' <> '${GROUP_TYPE}')`,
  ];
  if (subj.where) principalWhere.push(subj.where);

  // For identity rowType we count distinct identities the in-scope principals
  // map to (via IdentityMembers, which IS audited but we use current links for
  // the id→identity mapping — attribute reconstruction of Identities isn't
  // possible as that table isn't tracked).
  const subjectCountExpr = isIdentity
    ? `(SELECT COUNT(DISTINCT im."identityId")::int
          FROM "IdentityMembers" im WHERE im."principalId" IN (SELECT id FROM sp))`
    : `(SELECT COUNT(*)::int FROM sp)`;

  const sql = `
    WITH
    ${asofSurrogateCte('asof_principals', 'Principals', 'Principals')},
    ${asofSurrogateCte('asof_resources', 'Resources', 'Resources')},
    ${asofAssignmentsCte('asof_assign')},
    ${asofContainsCte('asof_contains')},
    -- A (user, group) membership is governed at D when the user held a
    -- membership in a governance resource (a business role / access package)
    -- that Contains the group at D. Pre-049 history recorded that membership as
    -- assignmentType='Governed'; from 049 on it is a normal Direct membership
    -- on a resource flagged governanceResource. (The derived governed=true
    -- intent rows are not history-tracked — see migration 050 — so coverage is
    -- always reconstructed from the membership + Contains facts.)
    coverage AS (
      SELECT DISTINCT ga.pid AS "userId", rr.child AS "groupId"
        FROM asof_assign ga
        JOIN asof_contains rr ON rr.parent = ga.rid
       WHERE ga.atype = 'Governed'
          OR EXISTS (
               SELECT 1 FROM asof_resources ar
                WHERE (ar.state->>'id') = ga.rid
                  AND COALESCE((ar.state->>'governanceResource')::boolean, false)
             )
    ),
    sp AS (
      SELECT (sp.state->>'id')::uuid AS id
        FROM asof_principals sp
       WHERE ${principalWhere.join(' AND ')}
    ),
    sr AS (
      SELECT (sr.state->>'id')::uuid AS id
        FROM asof_resources sr
       ${res.where ? `WHERE ${res.where}` : ''}
    ),
    pairs AS (
      SELECT a.rid, a.pid, bool_or(c."userId" IS NOT NULL) AS governed
        FROM asof_assign a
        LEFT JOIN coverage c ON c."userId" = a.pid AND c."groupId" = a.rid
       WHERE a.pid::uuid IN (SELECT id FROM sp)
         AND a.rid::uuid IN (SELECT id FROM sr)
       GROUP BY a.rid, a.pid
    )
    SELECT
      ${subjectCountExpr} AS principals,
      (SELECT COUNT(*)::int FROM sr) AS resources,
      (SELECT COUNT(*)::int FROM pairs) AS assignments,
      (SELECT COUNT(*)::int FROM pairs WHERE governed) AS governed
  `;

  const scopeMode = (subj.usedContext || res.usedContext) ? 'context-current' : 'attribute';
  return { sql, bindings, warnings, scopeMode };
}

// Earliest reliable reconstruction instant — the first audit event across the
// tables we read. Points before this are not plotted.
export function historyStartSql() {
  return `SELECT MIN("changedAt") AS start
            FROM "_history"
           WHERE "tableName" IN ('Principals','Resources','ResourceAssignments')`;
}

export { collectContextIds };
