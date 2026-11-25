// Who answers for a business role: one Accountable at most, any number of
// Responsible (migration 114). The holder is an account or a person.
//
// Precedence, so an automatic source never undoes a person's choice:
//   analyst  replaces any Accountable
//   import   replaces a sync or import Accountable, leaves an analyst's
//   sync     replaces an earlier sync Accountable, so a changed source owner follows

import * as db from '../db/connection.js';
import { catalogJoinSql } from './businessRoleCatalog.js';

export const OWNER_ROLES = Object.freeze(['Accountable', 'Responsible']);
export const OWNER_SOURCES = Object.freeze(['sync', 'import', 'analyst']);

// The holders a source may replace as Accountable.
const REPLACEABLE = { analyst: ['sync', 'import', 'analyst'], import: ['sync', 'import'], sync: ['sync'] };

const HOLDER_COLUMNS = new Set(['principalId', 'identityId']);

export async function loadBusinessRoleOwners(resourceId) {
  const r = await db.query(`
    SELECT o.id, o.role, o."principalId", o."identityId", o."addedBy",
           COALESCE(p."displayName", i."displayName") AS "displayName",
           COALESCE(p.email, i.email) AS email
      FROM "BusinessRoleOwners" o
      LEFT JOIN "Principals" p ON p.id = o."principalId"
      LEFT JOIN "Identities" i ON i.id = o."identityId"
     WHERE o."resourceId" = $1
     ORDER BY (o.role = 'Accountable') DESC, "displayName"
  `, [resourceId]);
  return r.rows;
}

// Clears the way for a new Accountable. Returns false when a holder this source
// may not replace is in the place, so the caller writes nothing.
async function makeRoomForAccountable(client, resourceId, holderCol, holderId, addedBy) {
  const current = await client.query(
    `SELECT id, "principalId", "identityId", "addedBy" FROM "BusinessRoleOwners"
      WHERE "resourceId" = $1 AND role = 'Accountable' FOR UPDATE`, [resourceId],
  );
  const row = current.rows[0];
  if (!row || row[holderCol] === holderId) return true;
  if (!REPLACEABLE[addedBy].includes(row.addedBy)) return false;
  await client.query(`DELETE FROM "BusinessRoleOwners" WHERE id = $1`, [row.id]);
  return true;
}

// An analyst's row stays an analyst's when an automatic source states the same
// holder again.
const upsertSql = (holderCol) => `
    INSERT INTO "BusinessRoleOwners" ("resourceId", "${holderCol}", role, "addedBy")
    VALUES ($1, $2, $3, $4)
    ON CONFLICT ("resourceId", "${holderCol}", role) WHERE "${holderCol}" IS NOT NULL
    DO UPDATE SET "addedBy" = CASE WHEN "BusinessRoleOwners"."addedBy" = 'analyst' THEN 'analyst' ELSE EXCLUDED."addedBy" END,
                  "updatedAt" = now()
    RETURNING id, role, "principalId", "identityId", "addedBy"`;

/**
 * Set one holder. Returns the row, or null when the source may not replace the
 * current Accountable.
 */
export async function setBusinessRoleOwner(resourceId, { role, holderCol, holderId }, addedBy = 'analyst') {
  if (!HOLDER_COLUMNS.has(holderCol)) throw new Error(`Unsupported holder column ${holderCol}`);
  if (!OWNER_SOURCES.includes(addedBy)) throw new Error(`Unsupported owner source ${addedBy}`);
  return db.tx(async (client) => {
    if (role === 'Accountable' && !(await makeRoomForAccountable(client, resourceId, holderCol, holderId, addedBy))) {
      return null;
    }
    const r = await client.query(upsertSql(holderCol), [resourceId, holderId, role, addedBy]);
    return r.rows[0];
  });
}

export async function removeBusinessRoleOwner(resourceId, ownerId) {
  const r = await db.query(`DELETE FROM "BusinessRoleOwners" WHERE id = $1 AND "resourceId" = $2`, [ownerId, resourceId]);
  return r.rowCount > 0;
}

export async function isBusinessRole(resourceId) {
  const row = await db.queryOne(`SELECT id FROM "Resources" WHERE id = $1 AND "resourceType" = 'BusinessRole'`, [resourceId]);
  return !!row;
}

// The business roles a person answers for, through any of their accounts: a row
// counts when it names their account, their person (Identity), or another account
// linked to that person — the same reach as a context's roles
// (auth/contextOwner.js findHeldContexts). Only rows whose role is in $3 count
// (the relative-permission policy decides which: auth/relativePermissions.js).
// Somebody both Accountable and Responsible for one role is listed once, as the
// stronger of the roles that count. Each row names the role portfolio (Catalog
// context) the role sits in — portfolioId and portfolioName, both null when it
// sits in none — so the owner's page can file the role under it.
export const OWNED_ROLES_SQL = `
    SELECT DISTINCT ON (r.id) r.id, r."displayName", o.role,
           pf.id AS "portfolioId", pf."displayName" AS "portfolioName"
      FROM "BusinessRoleOwners" o
      JOIN "Resources" r ON r.id = o."resourceId" AND r."resourceType" = 'BusinessRole' AND r."deletedAt" IS NULL
      ${catalogJoinSql('r.id', 'pf')}
     WHERE o.role = ANY($3::text[])
       AND (o."principalId" = $1::uuid
        OR ($2::uuid IS NOT NULL AND (
              o."identityId" = $2::uuid
           OR o."principalId" IN (SELECT m."principalId" FROM "IdentityMembers" m WHERE m."identityId" = $2::uuid))))
     ORDER BY r.id, (o.role = 'Accountable') DESC`;

const BOTH_ROLES = ['Accountable', 'Responsible'];

const byName = (a, b) => String(a.displayName ?? '').localeCompare(String(b.displayName ?? '')) || String(a.id).localeCompare(String(b.id));

/**
 * The roles the person behind `me` (auth/resolveMe.js) answers for as one of
 * `roles` (default: Accountable or Responsible), by name. Empty for nobody.
 */
export async function findOwnedBusinessRoles(me, roles = BOTH_ROLES) {
  const principalId = me?.principal?.id;
  if (!principalId || roles.length === 0) return [];
  const r = await db.query(OWNED_ROLES_SQL, [principalId, me.identity?.id ?? null, roles]);
  return r.rows.sort(byName);
}

/** Does the person behind `me` answer for this role as one of `roles` (default: either)? */
export async function answersForBusinessRole(me, roleId, roles = BOTH_ROLES) {
  const want = String(roleId).toLowerCase();
  return (await findOwnedBusinessRoles(me, roles)).some(r => String(r.id).toLowerCase() === want);
}
