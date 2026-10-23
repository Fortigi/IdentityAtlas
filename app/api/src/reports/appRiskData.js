// The facts the application risk score reads, one object per app.
//
// An "app" is a service principal (enterprise application, managed identity or
// AI agent) — the object that holds permissions and signs in. Its app
// registration, when this tenant owns one, is joined on appId. Every query
// reads one kind of fact for all apps at once; buildAppFacts (pure) folds the
// rows together, so the folding is tested without a database.
//
// Facts a toggle did not collect stay null rather than empty, so the rules can
// tell "no owners" from "owners not crawled".

import * as db from '../db/connection.js';
import { API_APP_ID_SQL, GRANTS_FROM, GRANTS_WHERE } from './appPermissionRisk.js';
import { permissionTier } from './appRiskPermissions.js';

// Tenants Microsoft publishes its own first-party apps from.
export const MICROSOFT_TENANT_IDS = new Set([
  'f8cdef31-a31e-4b4a-93e4-5f571e91255a', // Microsoft Services
  '72f988bf-86f1-41af-91ab-2d7cd011db47', // Microsoft (corporate)
]);

const APPS_SQL = `
  SELECT p.id::text AS id, p."displayName", p."principalType", p."accountEnabled", p."createdDateTime",
         p."extendedAttributes" AS ext
    FROM "Principals" p
   WHERE p."principalType" IN ('ServicePrincipal', 'ManagedIdentity', 'AIAgent')
     AND p."deletedAt" IS NULL`;

const REGISTRATIONS_SQL = `
  SELECT r."extendedAttributes" AS ext
    FROM "Resources" r
   WHERE r."resourceType" = 'AppRegistration' AND r."deletedAt" IS NULL`;

const APP_PERMISSIONS_SQL = `
  SELECT ra."principalId"::text AS "spId",
         ap."extendedAttributes"->>'permission' AS permission,
         ${API_APP_ID_SQL} AS "apiAppId"
  ${GRANTS_FROM}
   WHERE ${GRANTS_WHERE}`;

// One row per (client, API, scope): whether an admin consented it for everyone,
// and how many users consented it themselves.
const DELEGATED_SQL = `
  SELECT dp."extendedAttributes"->>'clientSpId' AS "spId",
         dp."extendedAttributes"->>'scope' AS scope,
         COALESCE((dp."extendedAttributes"->>'adminConsented')::boolean, false) AS "adminConsented",
         tsp."extendedAttributes"->>'appId' AS "apiAppId",
         COUNT(ra."principalId")::int AS "userCount"
    FROM "Resources" dp
    LEFT JOIN "Principals" tsp ON tsp.id::text = dp."extendedAttributes"->>'targetApiSpId' AND tsp."deletedAt" IS NULL
    LEFT JOIN "ResourceAssignments" ra ON ra."resourceId" = dp.id AND ra."deletedAt" IS NULL
   WHERE dp."resourceType" = 'DelegatedPermission' AND dp."deletedAt" IS NULL
   GROUP BY 1, 2, 3, 4`;

// Owners of the enterprise app and of its app registration. The owner's own row
// is read even when soft-deleted: a deleted owner is exactly what we look for.
const OWNERS_SQL = `
  SELECT rr."parentResourceId"::text AS "spId",
         ra."principalId"::text AS "ownerId",
         o."principalType", o."accountEnabled",
         (o.id IS NULL OR o."deletedAt" IS NOT NULL) AS deleted,
         o."extendedAttributes"->>'userType' AS "userType"
    FROM "ResourceRelationships" rr
    JOIN "Resources" own ON own.id = rr."childResourceId"
                        AND own."resourceType" IN ('ServicePrincipalOwnership', 'ApplicationOwnership')
                        AND own."deletedAt" IS NULL
    JOIN "ResourceAssignments" ra ON ra."resourceId" = own.id AND ra."deletedAt" IS NULL
    LEFT JOIN "Principals" o ON o.id = ra."principalId"
   WHERE rr."relationshipType" = 'HasAppOwnership'`;

// Whether ownership was crawled at all (an app with no owner rows then really has none).
const OWNERSHIP_CRAWLED_SQL = `SELECT EXISTS (SELECT 1 FROM "ResourceRelationships" WHERE "relationshipType" = 'HasAppOwnership') AS crawled`;

const ACTIVITY_SQL = `
  SELECT "principalId"::text AS "spId", "lastSignInDateTime", "lastNonInteractiveSignInDateTime",
         "extendedAttributes" AS ext
    FROM "PrincipalActivity"
   WHERE "activityType" = 'ServicePrincipalSignIn'`;

const TENANTS_SQL = `SELECT "tenantId" FROM "Systems" WHERE "systemType" = 'EntraID' AND "tenantId" IS NOT NULL`;

/** Run every query. Returns the raw row sets buildAppFacts expects. */
export async function loadAppRiskRows() {
  const [apps, regs, appPerms, delegated, owners, ownership, activity, tenants] = await Promise.all([
    db.query(APPS_SQL), db.query(REGISTRATIONS_SQL), db.query(APP_PERMISSIONS_SQL), db.query(DELEGATED_SQL),
    db.query(OWNERS_SQL), db.query(OWNERSHIP_CRAWLED_SQL), db.query(ACTIVITY_SQL), db.query(TENANTS_SQL),
  ]);
  return {
    apps: apps.rows, registrations: regs.rows, appPermissions: appPerms.rows, delegated: delegated.rows,
    owners: owners.rows, ownershipCrawled: Boolean(ownership.rows[0]?.crawled), activity: activity.rows,
    tenantIds: tenants.rows.map(t => String(t.tenantId).toLowerCase()),
  };
}

const lc = v => String(v ?? '').toLowerCase();

function groupBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    const k = lc(r[key]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

/** Whose tenant the app was registered in, from the service principal. */
export function ownerTenantOf(appOwnerOrganizationId, ownTenantIds) {
  const org = lc(appOwnerOrganizationId);
  if (!org) return 'Unknown';
  if (MICROSOFT_TENANT_IDS.has(org)) return 'Microsoft';
  if (ownTenantIds.has(org)) return 'This tenant';
  return 'Third party';
}

/** The latest of the four sign-in timestamps Graph reports for an app, or null. */
export function latestSignIn(row) {
  const stamps = [row.lastSignInDateTime, row.lastNonInteractiveSignInDateTime,
    row.ext?.lastApplicationAuthSignInDateTime, row.ext?.lastDelegatedClientSignInDateTime]
    .filter(Boolean).map(v => new Date(v).getTime()).filter(Number.isFinite);
  return stamps.length ? new Date(Math.max(...stamps)) : null;
}

function ownerFact(o) {
  return {
    id: o.ownerId, principalType: o.principalType ?? null, accountEnabled: o.accountEnabled,
    deleted: Boolean(o.deleted), guest: o.userType === 'Guest',
  };
}

function appFact(a, ix) {
  const ext = a.ext ?? {};
  const appId = lc(ext.appId);
  const id = lc(a.id);
  return {
    id: a.id, displayName: a.displayName, appId: ext.appId ?? null, principalType: a.principalType,
    accountEnabled: a.accountEnabled, createdDateTime: a.createdDateTime ?? null,
    sp: ext, reg: (appId && ix.regs.get(appId)) || null,
    ownerTenant: ownerTenantOf(ext.appOwnerOrganizationId, ix.tenantIds),
    appPermissions: (ix.appPerms.get(id) ?? []).map(p => ({
      permission: p.permission, apiAppId: p.apiAppId, tier: permissionTier({ kind: 'application', apiAppId: p.apiAppId, permission: p.permission }),
    })),
    delegated: (ix.delegated.get(id) ?? []).map(d => ({
      scope: d.scope, apiAppId: d.apiAppId, adminConsented: Boolean(d.adminConsented), userCount: Number(d.userCount) || 0,
      tier: permissionTier({ kind: 'delegated', apiAppId: d.apiAppId, permission: d.scope }),
    })),
    owners: ix.ownershipCrawled ? (ix.owners.get(id) ?? []).map(ownerFact) : null,
    activityKnown: ix.activityCrawled,
    lastSignIn: ix.activity.has(id) ? latestSignIn(ix.activity.get(id)[0]) : null,
  };
}

/** Fold the raw row sets into one fact object per app. Pure. */
export function buildAppFacts(rows) {
  const regs = new Map();
  for (const r of rows.registrations ?? []) if (r.ext?.appId) regs.set(lc(r.ext.appId), r.ext);
  const ix = {
    regs,
    tenantIds: new Set(rows.tenantIds ?? []),
    appPerms: groupBy(rows.appPermissions ?? [], 'spId'),
    delegated: groupBy(rows.delegated ?? [], 'spId'),
    owners: groupBy(rows.owners ?? [], 'spId'),
    ownershipCrawled: Boolean(rows.ownershipCrawled),
    activity: groupBy(rows.activity ?? [], 'spId'),
    activityCrawled: (rows.activity ?? []).length > 0,
  };
  return (rows.apps ?? []).map(a => appFact(a, ix));
}
