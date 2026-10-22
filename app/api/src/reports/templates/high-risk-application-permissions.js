// High-risk Application Permissions (Entra ID) — the apps that can read every
// mailbox, every site, or rewrite the directory, with nobody signed in.
//
// One row per application permission a service principal actually HOLDS on an
// API (an `appRoleAssignment` whose principal is the app itself), filtered to
// the shortlist in reports/appPermissionRisk.js. Three things it deliberately
// is not:
//
// - not what the app ASKED for (`requiredResourceAccess`) — the crawler never
//   stores that, so nothing requested-but-unconsented can appear here;
// - not delegated consent (`oauth2PermissionGrants`) — those are
//   DelegatedPermission resources and are excluded by resource type;
// - not a user's or group's assignment to an enterprise app's own roles —
//   those are AppRole resources, likewise excluded.
//
// The target API is matched on its appId (the same in every tenant), never on
// its name or the permission value alone, so a third-party API that happens to
// publish a role called `Mail.Read` is not reported as Microsoft Graph access.

import * as db from '../../db/connection.js';
import { classifyAppPermission } from '../appPermissionRisk.js';

export default {
  name: 'high-risk-application-permissions',
  displayName: 'High-risk Application Permissions (Entra ID)',
  description:
    'Application (app-only) permissions actually granted to service principals that reach SharePoint '
    + 'and OneDrive content, mailboxes, or directory control tenant-wide — one row per granted '
    + 'permission, with the API it is held on and a fixed category and severity from an explicit '
    + 'shortlist. Requested-but-unconsented permissions and delegated (user) consent are never listed.',
  form: 'list',
  parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [
    { key: 'clientName', label: 'Application' },
    { key: 'clientAppId', label: 'App ID' },
    { key: 'clientSpId', label: 'Service principal' },
    { key: 'clientType', label: 'Holder type' },
    { key: 'apiName', label: 'API' },
    { key: 'apiSpId', label: 'API service principal' },
    { key: 'permission', label: 'Permission' },
    { key: 'appRoleId', label: 'App role ID' },
    { key: 'permissionType', label: 'Type' },
    { key: 'status', label: 'Status' },
    { key: 'category', label: 'Category' },
    { key: 'severity', label: 'Severity' },
    { key: 'publisher', label: 'Publisher' },
    { key: 'systemName', label: 'System' },
    { key: 'lastSync', label: 'Last sync' },
  ],

  async run(params, ctx) {
    // Every live app-only grant, with the target API identified by appId —
    // stamped on the resource by the crawler, or, for data crawled before it
    // was, read from the API's own service-principal record when it is loaded.
    const r = await db.query(`
      SELECT ap.id AS "permissionId",
             ap."extendedAttributes"->>'permission'           AS "permission",
             ap."extendedAttributes"->>'appRoleId'            AS "appRoleId",
             ap."extendedAttributes"->>'targetApiSpId'        AS "apiSpId",
             ap."extendedAttributes"->>'targetApiDisplayName' AS "apiName",
             COALESCE(ap."extendedAttributes"->>'targetApiAppId', tsp."extendedAttributes"->>'appId') AS "apiAppId",
             ra."principalId"::text AS "clientSpId",
             ra."principalType"     AS "clientType",
             COALESCE(csp."displayName", ap."extendedAttributes"->>'clientDisplayName') AS "clientName",
             COALESCE(app."extendedAttributes"->>'appId', csp."extendedAttributes"->>'appId') AS "clientAppId",
             csp."extendedAttributes"->>'publisherName' AS "publisher",
             s."displayName" AS "systemName",
             s."lastSyncDateTime" AS "lastSync"
        FROM "ResourceAssignments" ra
        JOIN "Resources" ap ON ap.id = ra."resourceId"
                           AND ap."resourceType" = 'ApplicationPermission'
                           AND ap."deletedAt" IS NULL
        LEFT JOIN "Resources" app ON app.id = ra."principalId"
                                 AND app."resourceType" = 'Application'
                                 AND app."deletedAt" IS NULL
        LEFT JOIN "Principals" csp ON csp.id = ra."principalId" AND csp."deletedAt" IS NULL
        LEFT JOIN "Principals" tsp ON tsp.id::text = ap."extendedAttributes"->>'targetApiSpId'
                                  AND tsp."principalType" IN ('ServicePrincipal', 'ManagedIdentity', 'AIAgent')
                                  AND tsp."deletedAt" IS NULL
        LEFT JOIN "Systems" s ON s.id = ra."systemId"
       WHERE ra."deletedAt" IS NULL
         AND ra."assignmentType" = 'Direct'`);

    let unidentified = 0;
    const rows = [];
    for (const g of r.rows) {
      if (!g.apiAppId) unidentified++;
      const risk = classifyAppPermission({ targetApiAppId: g.apiAppId, permission: g.permission });
      if (!risk) continue;
      rows.push({
        clientName: g.clientName,
        clientAppId: g.clientAppId,
        clientSpId: g.clientSpId,
        clientType: g.clientType,
        apiName: risk.api,
        apiSpId: g.apiSpId,
        permission: g.permission,
        appRoleId: g.appRoleId,
        permissionType: 'Application',
        status: 'Granted',
        category: risk.category,
        severity: risk.severity,
        publisher: g.publisher,
        systemName: g.systemName,
        lastSync: g.lastSync ? new Date(g.lastSync).toISOString() : null,
        _entity: { kind: 'resource', id: g.clientSpId },
      });
    }
    rows.sort(bySeverityThenApp);

    const notices = [];
    if (r.rows.length === 0) {
      notices.push({
        severity: 'info',
        text: 'No application permissions are loaded. This report reads the Entra ID crawler\'s '
          + 'app-permission sync (SyncAppPermissions), which is off by default — an empty list only '
          + 'means nothing was collected, not that the tenant holds no such grants.',
      });
    }
    if (unidentified > 0) {
      notices.push({
        severity: 'warning',
        text: `${unidentified} granted permission(s) could not be matched to a known API because the `
          + 'target API\'s appId is not stored. Re-run the Entra ID crawler with app-permission sync '
          + 'to identify them; until then they are not listed here.',
      });
    }

    ctx?.log?.(`high-risk-application-permissions report: ${rows.length} high-risk grant(s) of ${r.rows.length} granted application permission(s)`);
    return { rows, notices };
  },
};

const SEVERITY_ORDER = { Critical: 0, High: 1 };

function bySeverityThenApp(a, b) {
  return (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    || String(a.clientName ?? '').localeCompare(String(b.clientName ?? ''))
    || a.apiName.localeCompare(b.apiName)
    || a.permission.localeCompare(b.permission);
}
