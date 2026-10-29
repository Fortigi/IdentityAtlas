// Context read endpoints — GET /api/contexts (roots), /contexts/tree,
// /contexts/:id (detail) and /contexts/:id/members (paginated).
//
// Extracted verbatim from routes/contexts.js (audit finding C1). Mounted by
// routes/contexts.js via router.use() so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { createParams, likeContains } from '../../db/sqlParams.js';
import { buildSearchWhere, parseExtendedSearch, withMatchedOn } from '../../lib/entitySearch.js';
import { CONTEXT_CATEGORIES } from '../../ingest/validation.js';
import { useSql, UUID_RE, TARGET_TYPES } from './shared.js';
import { loadContextRoles } from './roles.js';
import { OWNER_PRINCIPAL_ORDER } from '../../ingest/contextOwners.js';
import { withResourceMemberFacts } from '../../contexts/resourceMemberFacts.js';
import { UPLOAD_SYSTEM_TYPE, uploadProvenance } from '../../contexts/upload/lists.js';
import { SOFT_DELETE_TABLES } from '../../ingest/engine.js';

const router = Router();

const VARIANTS = new Set(['synced', 'generated', 'manual']);

// Map targetType → the table name where memberIds live. Used to filter the
// member list to live rows only (stale member rows are left to a background
// reconciler, not this endpoint): the member must exist, and — for the tables
// that carry a soft-delete tombstone (SOFT_DELETE_TABLES) — must not be deleted.
const MEMBER_TABLE = {
  Identity:  'Identities',
  Resource:  'Resources',
  Principal: 'Principals',
  System:    'Systems',
};

// What a member row carries besides its name, per kind of member — the columns
// the context's members table shows (email and job title for people and
// accounts, type and description for resources). A resource's extendedAttributes
// are read only for its owner reference and are not returned: a resource member
// also gets holderCount and its owner, from contexts/resourceMemberFacts.js.
export const MEMBER_COLUMNS = {
  Identity:  'm.email, m."jobTitle", m.department',
  Resource:  'm."resourceType", m.description, m.enabled, m."extendedAttributes"',
  Principal: 'm.email, m."jobTitle", m."principalType", m."accountEnabled"',
  System:    'm.description',
};

// How a member row joins its entity. ContextMembers."memberId" is a uuid, and so
// is the id of every member table except Systems (integer). Compare like with
// like: casting both sides to text hides both indexes, and the planner then falls
// back to a nested loop that checks every entity against every member — 4 minutes
// for one page of a 106k-member context at 41M assignments, and a deep page that
// never finished (docs/architecture/scale-rehearsal.md). Systems keep the text
// comparison; the table is tiny and its ids cannot equal a uuid either way.
export function memberJoinOn(targetType) {
  return targetType === 'System'
    ? 'm.id::text = cm."memberId"::text'
    : 'm.id = cm."memberId"';
}

// ─── Owner resolution ────────────────────────────────────────────────
// "Contexts"."ownerUserId" is free text: whatever the source calls the owner of
// a grouping — an IdentityIQ identity id, an employee number, an e-mail. To show
// a person instead of that string it has to be resolved to a Principal, and that
// happens HERE rather than in the browser: a list of 1,500 logical applications
// each firing its own lookup is fine in a demo and a thousand round-trips on real
// data.
//
// The same external id can exist in several systems (the ingest keys principals
// on (systemId, externalId), not on externalId alone), so the tie is broken, in
// order: a live row over a soft-deleted one, the context's own scope system over
// any other, then the id — so the answer is stable between two identical calls.
// Needs ix_Principals_externalId (migration 076); without it this is a
// sequential scan of the whole Principals table per context row.
//
// The tie-break is OWNER_PRINCIPAL_ORDER, shared with the ingest that states a
// synced owner as the context's Accountable (ingest/contextOwners.js), so the
// owner shown here and the Accountable are the same account. (The ingest also
// falls back to a unique employeeId, which this per-row join does not.)
//
// Exported so the tests can pin the shape rather than matching a substring.
export const OWNER_COLUMNS = 'own.id AS "ownerPrincipalId", own."displayName" AS "ownerDisplayName"';

export const OWNER_JOIN = `
        LEFT JOIN LATERAL (
          SELECT p.id, p."displayName"
            FROM "Principals" p
           WHERE p."externalId" = c."ownerUserId"
           ORDER BY ${OWNER_PRINCIPAL_ORDER}
           LIMIT 1
        ) own ON TRUE`;

// ─── GET /api/contexts ───────────────────────────────────────────────
// List all root contexts (parentContextId IS NULL). Optional filters:
// ?targetType, ?variant, ?contextType, ?contextCategory (one of the four
// templates), ?sourceAlgorithm (the producing plugin's name), ?scopeSystemId.
//
// ?search= looks at every level, not only the roots — the logical application
// you are looking for by its CMDB reference usually sits under a catalogue —
// and returns at most SEARCH_LIMIT matches, each with its parent and the
// fields it matched on. ?extendedSearch=true searches every attribute
// (lib/entitySearch.js).
export const SEARCH_LIMIT = 1000;

export function buildContextListWhere(query, bind) {
  const search = String(query.search ?? '').trim().slice(0, 200);
  const clauses = search ? [] : ['c."parentContextId" IS NULL'];
  const eq = (col, val) => clauses.push(`c."${col}" = ${bind(val)}`);
  if (query.targetType && TARGET_TYPES.has(query.targetType)) eq('targetType', query.targetType);
  if (query.variant && VARIANTS.has(query.variant))           eq('variant', query.variant);
  if (query.contextType) eq('contextType', String(query.contextType).slice(0, 100));
  if (CONTEXT_CATEGORIES.includes(query.contextCategory)) eq('contextCategory', query.contextCategory);
  // The algorithm is joined as `a` by every caller of this WHERE.
  if (query.sourceAlgorithm) clauses.push(`a.name = ${bind(String(query.sourceAlgorithm).slice(0, 100))}`);
  if (query.scopeSystemId) {
    const sys = parseInt(query.scopeSystemId, 10);
    if (!Number.isNaN(sys)) eq('scopeSystemId', sys);
  }
  const extended = parseExtendedSearch(query);
  const where = (clauses.join(' AND ') || 'TRUE') + buildSearchWhere('context', 'c', search, { extended }, bind);
  return { where, search, extended };
}

router.get('/contexts', async (req, res) => {
  if (!useSql) return res.json({ data: [], total: 0 });
  try {
    const { params, bind } = createParams();
    const { where, search, extended } = buildContextListWhere(req.query, bind);

    const r = await db.query(`
      SELECT c.id, c.variant, c."targetType", c."contextType", c."contextCategory", c."displayName",
             c.description, c."scopeSystemId", c."sourceAlgorithmId", c."ownerUserId",
             c."createdByUser", c."externalId", c."directMemberCount", c."totalMemberCount",
             c."userRenamed", c."userReparented", c."sourceInstanceKey",
             c."lastCalculatedAt", c."createdAt", c."updatedAt",
             s."displayName" AS "scopeSystemName", s."systemType" AS "scopeSystemType",
             a.name AS "sourceAlgorithmName",
             a."displayName" AS "sourceAlgorithmDisplayName",
             ${search ? 'c."parentContextId", c."extendedAttributes",' : ''}
             ${OWNER_COLUMNS}
        FROM "Contexts" c
        LEFT JOIN "Systems" s ON c."scopeSystemId" = s.id
        LEFT JOIN "ContextAlgorithms" a ON c."sourceAlgorithmId" = a.id${OWNER_JOIN}
       WHERE ${where}
       ORDER BY c."contextType", COALESCE(c."totalMemberCount", 0) DESC, c."displayName"
       ${search ? `LIMIT ${SEARCH_LIMIT}` : ''}
    `, params);

    const data = withMatchedOn('context', r.rows, search, { extended });
    res.json({ data, total: data.length });
  } catch (err) {
    console.error('GET /contexts failed:', err.message);
    res.status(500).json({ error: 'Failed to load contexts' });
  }
});

// ─── GET /api/contexts/tree ──────────────────────────────────────────
// Build a nested tree. With ?root=<id>, returns that subtree. Without,
// returns an array with one entry per root context (every root at top level).
router.get('/contexts/tree', async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    const rootParam = req.query.root;
    let rows;
    if (rootParam) {
      if (!UUID_RE.test(rootParam)) return res.status(400).json({ error: 'Invalid root id' });
      rows = (await db.query(`
        WITH RECURSIVE descendants AS (
          SELECT * FROM "Contexts" WHERE id = $1
          UNION ALL
          SELECT c.* FROM "Contexts" c JOIN descendants d ON c."parentContextId" = d.id
        )
        -- CYCLE guard: a corrupt parent chain (A→B→A) would otherwise recurse
        -- forever. PG stops descending the moment an id repeats on the path.
        CYCLE id SET "isCycle" USING "cyclePath"
        SELECT id, variant, "targetType", "contextType", "contextCategory", "displayName", description,
               "parentContextId", "scopeSystemId", "sourceAlgorithmId", "ownerUserId",
               "directMemberCount", "totalMemberCount", "userRenamed", "userReparented"
          FROM descendants
         ORDER BY "displayName"
      `, [rootParam])).rows;
    } else {
      rows = (await db.query(`
        SELECT id, variant, "targetType", "contextType", "contextCategory", "displayName", description,
               "parentContextId", "scopeSystemId", "sourceAlgorithmId", "ownerUserId",
               "directMemberCount", "totalMemberCount", "userRenamed", "userReparented"
          FROM "Contexts"
         ORDER BY "contextType", "displayName"
      `)).rows;
    }

    if (rows.length === 0) return res.json([]);

    // Build nested structure by parentContextId.
    const byId = new Map();
    rows.forEach(r => byId.set(r.id, { ...r, children: [] }));
    const roots = [];
    byId.forEach(node => {
      if (node.parentContextId && byId.has(node.parentContextId)) {
        byId.get(node.parentContextId).children.push(node);
      } else {
        roots.push(node);
      }
    });

    // Sort by totalMemberCount DESC, then displayName ASC as tiebreaker.
    // Largest subtrees bubble to the top in every level — much more useful
    // than alphabetic for org-sized trees (99 departments, 500 managers).
    const cmp = (a, b) => {
      const at = a.totalMemberCount || 0;
      const bt = b.totalMemberCount || 0;
      if (at !== bt) return bt - at;
      return (a.displayName || '').localeCompare(b.displayName || '');
    };
    const sortRec = n => { n.children.sort(cmp); n.children.forEach(sortRec); };
    roots.sort(cmp);
    roots.forEach(sortRec);

    res.json(roots);
  } catch (err) {
    console.error('GET /contexts/tree failed:', err.message);
    res.status(500).json({ error: 'Failed to load context tree' });
  }
});

// ─── GET /api/contexts/:id ───────────────────────────────────────────
// The detail carries the context's roles (Accountable / Responsible) too: the
// detail page shows the template badge and the People block in one paint, and
// the roles lookup is one indexed read per context. /contexts/:id/roles stays
// for the People block's refresh after an add or remove.
router.get('/contexts/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ attributes: null, members: [], subContexts: [], roles: [] });

  try {
    const attr = await db.queryOne(`
      SELECT c.*, s."displayName" AS "scopeSystemName", s."systemType" AS "scopeSystemType",
             a.name AS "sourceAlgorithmName",
             a."displayName" AS "sourceAlgorithmDisplayName",
             parent."displayName" AS "parentDisplayName",
             ${OWNER_COLUMNS}
        FROM "Contexts" c
        LEFT JOIN "Systems" s           ON c."scopeSystemId" = s.id
        LEFT JOIN "ContextAlgorithms" a ON c."sourceAlgorithmId" = a.id
        LEFT JOIN "Contexts" parent     ON c."parentContextId" = parent.id${OWNER_JOIN}
       WHERE c.id = $1
    `, [req.params.id]);

    if (!attr) return res.status(404).json({ error: 'Context not found' });

    // A context of an uploaded list says where it came from: its first and latest upload.
    if (attr.scopeSystemType === UPLOAD_SYSTEM_TYPE) Object.assign(attr, await uploadProvenance(db, attr.scopeSystemId));

    const members = await loadMembers(req.params.id, attr.targetType, { limit: 50 });

    const subs = (await db.query(`
      SELECT id, variant, "targetType", "contextType", "contextCategory", "displayName",
             "directMemberCount", "totalMemberCount"
        FROM "Contexts"
       WHERE "parentContextId" = $1
       ORDER BY "displayName"
    `, [req.params.id])).rows;

    const roles = await loadContextRoles(req.params.id);

    res.json({ attributes: attr, members, subContexts: subs, roles });
  } catch (err) {
    console.error('GET /contexts/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to load context details' });
  }
});

// ─── GET /api/contexts/:id/members ───────────────────────────────────
// Paginated members. Optional ?search filters on the member's display name.
router.get('/contexts/:id/members', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  if (!useSql) return res.json({ data: [], total: 0 });

  try {
    const ctx = await db.queryOne(`SELECT "targetType" FROM "Contexts" WHERE id = $1`, [req.params.id]);
    if (!ctx) return res.status(404).json({ error: 'Context not found' });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const search = (req.query.search || '').toString().trim().slice(0, 200);
    const includeDescendants = req.query.include === 'descendants';

    const { rows, total } = await loadMembers(req.params.id, ctx.targetType, {
      limit, offset, search, withTotal: true, includeDescendants,
    });
    res.json({ data: rows, total });
  } catch (err) {
    console.error('GET /contexts/:id/members failed:', err.message);
    res.status(500).json({ error: 'Failed to load context members' });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────

// The SQL pieces that scope a member read to this context alone, or to it and
// every descendant. With descendants, $1 expands into "this context plus every
// descendant" via a recursive CTE, and the member rows are de-duplicated on
// memberId (a person could be a direct member of two sub-contexts; we want them
// once) — the DISTINCT adds a small sort cost but keeps counts and paging right.
function memberScopeSql(includeDescendants) {
  if (!includeDescendants) {
    return { contextFilter: `cm."contextId" = $1`, distinct: '', orderPrefix: '', countExpr: '*' };
  }
  return {
    contextFilter: `cm."contextId" IN (
        WITH RECURSIVE subtree AS (
          SELECT id FROM "Contexts" WHERE id = $1
          UNION ALL
          SELECT c.id FROM "Contexts" c JOIN subtree s ON c."parentContextId" = s.id
        )
        -- CYCLE guard: corrupt parent chains must not recurse forever.
        CYCLE id SET "isCycle" USING "cyclePath"
        SELECT id FROM subtree
      )`,
    distinct: 'DISTINCT ON (m.id)',
    orderPrefix: 'm.id, ',
    countExpr: 'DISTINCT m.id',
  };
}

async function loadMembers(contextId, targetType, { limit = 100, offset = 0, search = '', withTotal = false, includeDescendants = false } = {}) {
  const table = MEMBER_TABLE[targetType];
  if (!table) return withTotal ? { rows: [], total: 0 } : [];

  // Every member table has displayName; the rest of the row is what the members
  // table shows for that kind of member (MEMBER_COLUMNS).
  const params = [contextId];
  let searchClause = '';
  if (search) {
    params.push(likeContains(search));
    searchClause = ` AND m."displayName" ILIKE $${params.length} ESCAPE '\\'`;
  }

  const { contextFilter, distinct, orderPrefix, countExpr } = memberScopeSql(includeDescendants);

  // A context is a generated view of current state: a soft-deleted principal or
  // resource is no longer a member, in the list or in the total.
  const liveClause = SOFT_DELETE_TABLES.has(table) ? ' AND m."deletedAt" IS NULL' : '';

  const dataSql = `
    SELECT ${distinct} m.id, m."displayName", ${MEMBER_COLUMNS[targetType]},
           cm."addedBy", cm."addedAt"
      FROM "ContextMembers" cm
      JOIN "${table}" m ON ${memberJoinOn(targetType)}
     WHERE ${contextFilter}
       AND cm."memberType" = '${targetType}'${liveClause}
       ${searchClause}
     ORDER BY ${orderPrefix}m."displayName"
     LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}
  `;
  const page = (await db.query(dataSql, params)).rows;
  const rows = targetType === 'Resource' ? await withResourceMemberFacts(page) : page;
  if (!withTotal) return rows;

  const countSql = `
    SELECT COUNT(${countExpr})::int AS total
      FROM "ContextMembers" cm
      JOIN "${table}" m ON ${memberJoinOn(targetType)}
     WHERE ${contextFilter}
       AND cm."memberType" = '${targetType}'${liveClause}
       ${searchClause}
  `;
  const total = (await db.queryOne(countSql, params))?.total || 0;
  return { rows, total };
}

export default router;
