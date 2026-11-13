// "Which contexts does this signed-in person answer for?"
//
// Context-owner access (docs/architecture/context-owner-access.md) lets a person
// who is Accountable or Responsible for a context sign in without an Identity
// Atlas role and see that context — nothing else. This file answers the data
// half of that: who the caller is in our data (auth/resolveMe.js) and which
// ContextRoles rows name them. The request half — which endpoints such a caller
// may reach — is auth/contextOwnerScope.js.
//
// A role counts when it names the caller's account, the caller's person
// (Identity), or any other account linked to that person: a role given to
// someone's admin account still makes the person its owner.
//
// The scope also takes in each held context's variants (SameUnitAs): "Contoso"
// as its people, its accounts and its resources is one unit: the owner switches
// between those views, and a people unit's report lives on its accounts view (the
// report itself always runs on the context it is opened from).
//
// And it takes in ALL the held contexts' sub-units, at any depth (descendants
// through parentContextId) — hierarchical accountability: whoever answers for a
// unit answers for everything below it, also a sub-unit that has an Accountable
// or Responsible of its own. That sub-unit's owner, in turn, gets only their own
// subtree (nothing walks upward). A sub-unit's variants are not added (only a
// held context's are).
//
// Every function takes the pool explicitly so the contract test can run the
// exact statements against PostgreSQL (contract-tests/contextOwner.contract.test.js).

import * as db from '../db/connection.js';
import { isMissingSchema } from '../db/schemaErrors.js';
import { resolveMe } from './resolveMe.js';

const lower = (id) => String(id).toLowerCase();

// One row per (context, role) the person holds, through any of their accounts.
export async function findHeldContexts(pool, principalId, identityId) {
  const { rows } = await pool.query(
    `SELECT c.id, c."displayName", c."contextCategory", c."targetType", r.role
       FROM "ContextRoles" r
       JOIN "Contexts" c ON c.id = r."contextId"
      WHERE r."principalId" = $1::uuid
         OR ($2::uuid IS NOT NULL AND (
               r."identityId" = $2::uuid
            OR r."principalId" IN (SELECT m."principalId" FROM "IdentityMembers" m WHERE m."identityId" = $2::uuid)))
      ORDER BY c."displayName", c.id`,
    [principalId, identityId],
  );
  return collapseHeld(rows);
}

// One entry per context. Somebody both Accountable and Responsible for one
// context is shown as Accountable — the stronger of the two.
export function collapseHeld(rows) {
  const byId = new Map();
  for (const r of rows) {
    const id = lower(r.id);
    const prev = byId.get(id);
    if (prev && prev.role === 'Accountable') continue;
    byId.set(id, {
      id,
      displayName: r.displayName,
      role: r.role,
      contextCategory: r.contextCategory ?? null,
      targetType: r.targetType ?? null,
    });
  }
  return [...byId.values()];
}

// The other end of every SameUnitAs link that touches one of `ids`.
export async function findSameUnitVariants(pool, ids) {
  if (ids.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT CASE WHEN r."contextId" = ANY($1::uuid[]) THEN r."relatedContextId" ELSE r."contextId" END AS id
       FROM "ContextRelationships" r
      WHERE r."relationshipType" = 'SameUnitAs'
        AND (r."contextId" = ANY($1::uuid[]) OR r."relatedContextId" = ANY($1::uuid[]))`,
    [ids],
  );
  return rows.map(r => lower(r.id));
}

// The sub-units below `ids`: every descendant at any depth, whoever else
// answers for it. One recursive statement over parentContextId (indexed), so a
// top-level owner with thousands of units costs one round trip. CYCLE guards a
// corrupt parent chain.
export async function findOwnedSubUnits(pool, ids) {
  if (ids.length === 0) return [];
  const { rows } = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT c.id FROM "Contexts" c WHERE c."parentContextId" = ANY($1::uuid[])
       UNION ALL
       SELECT c.id FROM "Contexts" c JOIN sub s ON c."parentContextId" = s.id
     ) CYCLE id SET "isCycle" USING "cyclePath"
     SELECT DISTINCT id FROM sub WHERE NOT "isCycle"`,
    [ids],
  );
  return rows.map(r => lower(r.id));
}

// Whether every descendant of `ids` is in `contextIds` — for a request that
// reads a context with its sub-units (the unit report's includeSubUnits, a
// matrix condition's includeChildren). Held contexts' descendants always are;
// a variant's need not be.
export async function descendantsInScope(pool, ids, contextIds) {
  if (ids.length === 0) return true;
  const below = await findOwnedSubUnits(pool, ids);
  return below.every(id => contextIds.has(id));
}

// The contexts the Entitlement Pivot would run on for these `contexts` values.
// Same matching as the report template (a name, case-insensitive, or an id)
// but over every context rather than resources-only — wider is the safe
// direction for a check: anything the report could pick up is seen here.
export async function resolveReportContexts(pool, wanted) {
  const { rows } = await pool.query(
    `SELECT c.id FROM "Contexts" c
      WHERE lower(c."displayName") = ANY($1::text[]) OR c.id::text = ANY($1::text[])`,
    [wanted.map(lower)],
  );
  return rows.map(r => lower(r.id));
}

// req.user → { contexts, contextIds } or null when the caller holds no role (or
// cannot be matched to our data). `contexts` is what the UI lists; `contextIds`
// is the scope the API enforces (held contexts, their own sub-units and their
// variants).
export async function resolveContextOwner(user) {
  const me = await resolveMe(user);
  if (!me?.principal?.id) return null;
  try {
    const pool = await db.getPool();
    const contexts = await findHeldContexts(pool, me.principal.id, me.identity?.id ?? null);
    if (contexts.length === 0) return null;
    const heldIds = contexts.map(c => c.id);
    const subUnits = await findOwnedSubUnits(pool, heldIds);
    const variants = await findSameUnitVariants(pool, heldIds);
    return { contexts, contextIds: new Set([...heldIds, ...subUnits, ...variants]) };
  } catch (err) {
    // Before migration 095 there are no roles, so nobody is an owner yet.
    if (isMissingSchema(err)) return null;
    throw err;
  }
}
