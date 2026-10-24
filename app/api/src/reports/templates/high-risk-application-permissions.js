// High-risk Application Permissions (Entra ID) — the apps that can read every
// mailbox, every site, or rewrite the directory, with nobody signed in.
//
// One row per application permission a service principal actually HOLDS on an
// API (an `appRoleAssignment` whose principal is the app itself), filtered to
// the standard shortlist in reports/appPermissionRisk.js plus whatever the
// reader adds. Three things it deliberately is not:
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
// A permission the reader adds is picked as (API, permission) for the same
// reason.

import * as db from '../../db/connection.js';
import { parseList } from '../accessReviewFields.js';
import {
  API_APP_ID_SQL, GRANTS_FROM, GRANTS_WHERE,
  classifyAppPermission, knownApiName, parsePermissionKey, permissionKey,
} from '../appPermissionRisk.js';

const MAX_EXTRA = 200;

// What a permission the reader added reads as. It has no severity: the shortlist
// is the only place one is assigned, and inventing one here would put a
// judgement in the report that nobody made.
const ADDED = Object.freeze({ category: 'Added to this report', severity: null });

/** The run's choices from its raw parameters, whatever form they arrived in. */
export function parseOptions(params = {}) {
  const raw = params.includeStandard;
  const includeStandard = !(raw === false || String(raw).toLowerCase() === 'false');
  const extras = new Set(parseList(params.extraPermissions, MAX_EXTRA)
    .map(parsePermissionKey).filter(Boolean)
    .map(k => permissionKey(k.apiAppId, k.permission)));
  return { includeStandard, extras };
}

// The standard list's verdict when it is on and covers the grant; otherwise the
// reader's, when they added it; otherwise the grant is not listed.
function classify(grant, { includeStandard, extras }) {
  if (!grant.apiAppId || !grant.permission) return null;
  const standard = includeStandard ? classifyAppPermission({ targetApiAppId: grant.apiAppId, permission: grant.permission }) : null;
  if (standard) return standard;
  if (!extras.has(permissionKey(grant.apiAppId, grant.permission))) return null;
  return { api: knownApiName(grant.apiAppId) || grant.apiName || grant.apiAppId, ...ADDED };
}

export default {
  name: 'high-risk-application-permissions',
  displayName: 'High-risk Application Permissions (Entra ID)',
  description:
    'Application (app-only) permissions actually granted to service principals that reach SharePoint '
    + 'and OneDrive content, mailboxes, or directory control tenant-wide — one row per granted '
    + 'permission, with the API it is held on and a fixed category and severity from a standard '
    + 'shortlist. You can add other granted permissions, or switch the standard list off. '
    + 'Requested-but-unconsented permissions and delegated (user) consent are never listed.',
  form: 'list',
  parametersSchema: {
    type: 'object',
    required: [],
    properties: {
      includeStandard: {
        type: 'boolean',
        title: 'Standard high-risk list',
        description: 'The built-in shortlist: SharePoint and OneDrive content, mailboxes and directory '
          + 'control on Microsoft Graph, SharePoint Online and Exchange Online. Switch it off to list '
          + 'only the permissions added below.',
        default: true,
      },
      extraPermissions: {
        type: 'array',
        title: 'Also include',
        description: 'Other permissions to list, picked from the ones granted in this deployment. Each '
          + 'choice is a permission on one API, so a same-named permission on another API is not '
          + 'included with it.',
        'x-lookup': 'application-permissions',
        'x-lookupPlaceholder': 'Search granted permissions…',
      },
    },
  },
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
    const options = parseOptions(params);
    const r = await db.query(`
      SELECT ap.id AS "permissionId",
             ap."extendedAttributes"->>'permission'           AS "permission",
             ap."extendedAttributes"->>'appRoleId'            AS "appRoleId",
             ap."extendedAttributes"->>'targetApiSpId'        AS "apiSpId",
             ap."extendedAttributes"->>'targetApiDisplayName' AS "apiName",
             ${API_APP_ID_SQL} AS "apiAppId",
             ra."principalId"::text AS "clientSpId",
             ra."principalType"     AS "clientType",
             COALESCE(csp."displayName", ap."extendedAttributes"->>'clientDisplayName') AS "clientName",
             COALESCE(app."extendedAttributes"->>'appId', csp."extendedAttributes"->>'appId') AS "clientAppId",
             csp."extendedAttributes"->>'publisherName' AS "publisher",
             s."displayName" AS "systemName",
             s."lastSyncDateTime" AS "lastSync"
      ${GRANTS_FROM}
        LEFT JOIN "Resources" app ON app.id = ra."principalId"
                                 AND app."resourceType" = 'Application'
                                 AND app."deletedAt" IS NULL
        LEFT JOIN "Principals" csp ON csp.id = ra."principalId" AND csp."deletedAt" IS NULL
        LEFT JOIN "Systems" s ON s.id = ra."systemId"
       WHERE ${GRANTS_WHERE}`);

    let unidentified = 0;
    const rows = [];
    for (const g of r.rows) {
      if (!g.apiAppId) unidentified++;
      const risk = classify(g, options);
      if (risk) rows.push(toRow(g, risk));
    }
    rows.sort(bySeverityThenApp);

    const notices = buildNotices({ collected: r.rows.length, unidentified, options });
    ctx?.log?.(`high-risk-application-permissions report: ${rows.length} listed grant(s) of ${r.rows.length} granted application permission(s)`);
    return { rows, notices };
  },
};

function toRow(g, risk) {
  return {
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
    // The holder is a Principals row (the client service principal), not a resource.
    _entity: { kind: 'user', id: g.clientSpId },
  };
}

function buildNotices({ collected, unidentified, options }) {
  const notices = [];
  if (collected === 0) {
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
  if (!options.includeStandard) {
    notices.push({
      severity: 'info',
      text: options.extras.size
        ? 'The standard high-risk list is off: only the permissions added to this report are listed.'
        : 'The standard high-risk list is off and no permissions were added, so nothing is listed.',
    });
  }
  return notices;
}

// Critical, then High, then the reader's additions (no severity).
const SEVERITY_ORDER = { Critical: 0, High: 1 };

function bySeverityThenApp(a, b) {
  return ((SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2))
    || String(a.clientName ?? '').localeCompare(String(b.clientName ?? ''))
    || a.apiName.localeCompare(b.apiName)
    || a.permission.localeCompare(b.permission);
}
