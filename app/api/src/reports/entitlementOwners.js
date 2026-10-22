// Who owns each entitlement of an Entitlement Pivot run.
//
// Two places an owner can come from, tried in this order per entitlement:
//
//   1. The ownership LINK — the data model's one way to say "X owns Y": a
//      synthetic ownership resource, an ownership relationship to it, and a plain
//      Direct assignment per owner. The person's name, employee ID and e-mail
//      come from the Principal.
//   2. The source's own REFERENCE. A source that names an owner on its
//      entitlements but did not have the link built (the SQL crawler's
//      IdentityIQ preset leaves "Owners from ownerId" off, for cost) still keeps
//      the raw `ownerId` / `ownerName` in extendedAttributes. The reference is
//      resolved the way the contexts ingest resolves a context owner
//      (ingest/contextOwners.js): Principals.externalId first (a live row over a
//      soft-deleted one), else Principals.employeeId when exactly ONE live account
//      carries it. Failing both, the source's name for the owner (or its id) is
//      shown as-is, so a reviewer still sees who the source says it is.
//
// Both reads are set-based — one statement each, run once per report, never once
// per entitlement: a logical application can hold tens of thousands of them.

import * as db from '../db/connection.js';
import { OWNERSHIP_RELATIONSHIP_TYPES_SQL, OWNERSHIP_TYPES_SQL } from '../lib/ownershipTypes.js';

// One row per (entitlement, owner) rather than a pre-aggregated string, because
// "how many distinct people own anything here" cannot be recovered from an
// aggregate that has already collapsed each entitlement's owners.
async function fetchLinkedOwners(ids) {
  const { rows } = await db.query(
    `SELECT DISTINCT rr."parentResourceId" AS id, p.id AS "ownerId",
            p."displayName" AS "ownerName", p.email AS "ownerEmail", p."employeeId" AS "ownerEmployeeId"
       FROM "ResourceRelationships" rr
       JOIN "Resources" o ON o.id = rr."childResourceId"
        AND o."resourceType" IN ${OWNERSHIP_TYPES_SQL}
        AND o."deletedAt" IS NULL
       JOIN "ResourceAssignments" ra ON ra."resourceId" = o.id
        AND ra."assignmentType" = 'Direct'
        AND ra."deletedAt" IS NULL
       JOIN "Principals" p ON p.id = ra."principalId" AND p."deletedAt" IS NULL
      WHERE rr."relationshipType" IN ${OWNERSHIP_RELATIONSHIP_TYPES_SQL}
        AND rr."parentResourceId" = ANY($1::uuid[])
      ORDER BY rr."parentResourceId", p."displayName"`, [ids]);
  return groupOwners(rows);
}

/**
 * `(entitlement, owner)` rows folded into one entry per entitlement, keeping the
 * owner ids so the distinct-owner summary counts people rather than links.
 * An entitlement with two owners shows both, comma-separated.
 */
export function groupOwners(rows) {
  const byEntitlement = new Map();
  for (const row of rows) {
    const entry = byEntitlement.get(row.id)
      || { names: [], emails: [], employeeIds: [], ids: new Set() };
    if (row.ownerName) entry.names.push(row.ownerName);
    if (row.ownerEmail) entry.emails.push(row.ownerEmail);
    if (row.ownerEmployeeId) entry.employeeIds.push(row.ownerEmployeeId);
    entry.ids.add(row.ownerId);
    byEntitlement.set(row.id, entry);
  }
  return new Map([...byEntitlement].map(([id, e]) => [id, {
    ownerName: e.names.join(', ') || null,
    ownerEmail: e.emails.join(', ') || null,
    ownerEmployeeId: e.employeeIds.join(', ') || null,
    ownerIds: [...e.ids],
  }]));
}

// The attribute names a source uses for its owner reference, compared without
// case or underscores: `ownerId`, `ownerid`, `owner_id` are one key.
const normalise = key => String(key).replace(/[_\s]/g, '').toLowerCase();

function stringAttribute(attrs, wanted) {
  if (!attrs || typeof attrs !== 'object') return null;
  for (const key of Object.keys(attrs)) {
    if (normalise(key) !== wanted) continue;
    const value = attrs[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/** The owner a resource's source named in its attributes: `{ ref, name }`, either may be null. */
export function ownerReference(entitlement) {
  const attrs = entitlement?.extendedAttributes;
  return { ref: stringAttribute(attrs, 'ownerid'), name: stringAttribute(attrs, 'ownername') };
}

// Each reference → the account it names, in one statement for all of them.
async function resolveReferences(refs) {
  if (!refs.length) return new Map();
  const { rows } = await db.query(
    `WITH refs AS (SELECT DISTINCT unnest($1::text[]) AS ref),
     by_external_id AS (
       SELECT DISTINCT ON (r.ref) r.ref, p.id, p."displayName", p.email, p."employeeId"
         FROM refs r
         JOIN "Principals" p ON p."externalId" = r.ref
        ORDER BY r.ref, (p."deletedAt" IS NULL) DESC, p.id
     ),
     by_employee_id AS (
       SELECT r.ref, (array_agg(p.id))[1] AS id, (array_agg(p."displayName"))[1] AS "displayName",
              (array_agg(p.email))[1] AS email, (array_agg(p."employeeId"))[1] AS "employeeId"
         FROM refs r
         JOIN "Principals" p ON p."employeeId" = r.ref AND p."deletedAt" IS NULL
        WHERE NOT EXISTS (SELECT 1 FROM by_external_id x WHERE x.ref = r.ref)
        GROUP BY r.ref
       HAVING count(*) = 1
     )
     SELECT * FROM by_external_id
     UNION ALL
     SELECT * FROM by_employee_id`, [refs]);
  return new Map(rows.map(r => [r.ref, r]));
}

/**
 * The owner of one entitlement that has no ownership link, from its reference:
 * the resolved account, else the source's own words, else nothing. An owner
 * nobody could resolve is counted as one owner per reference, so the
 * distinct-owner summary still counts them.
 */
export function referencedOwner({ ref, name }, resolved) {
  const account = ref ? resolved.get(ref) : null;
  if (account) {
    return {
      ownerName: account.displayName ?? null,
      ownerEmail: account.email ?? null,
      ownerEmployeeId: account.employeeId ?? null,
      ownerIds: [account.id],
    };
  }
  if (!ref && !name) return null;
  return { ownerName: name ?? ref, ownerEmail: null, ownerEmployeeId: null, ownerIds: [`source:${ref ?? name}`] };
}

/**
 * Entitlement id → owner entry (`{ ownerName, ownerEmail, ownerEmployeeId,
 * ownerIds }`) for every entitlement that has an owner by either route. Two
 * reads, in parallel, whatever the number of entitlements.
 */
export async function fetchOwners(entitlements) {
  const ids = [...new Set(entitlements.map(e => e.id))];
  const references = new Map(entitlements.map(e => [e.id, ownerReference(e)]));
  const refs = [...new Set([...references.values()].map(r => r.ref).filter(Boolean))];
  const [linked, resolved] = await Promise.all([fetchLinkedOwners(ids), resolveReferences(refs)]);
  const owners = new Map(linked);
  for (const [id, reference] of references) {
    if (owners.has(id)) continue;
    const owner = referencedOwner(reference, resolved);
    if (owner) owners.set(id, owner);
  }
  return owners;
}
