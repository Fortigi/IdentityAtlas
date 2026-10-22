// The shortlist of high-risk application permissions, and the one function that
// applies it.
//
// An *application permission* is an app role one service principal holds on
// another API, app-only: no user is involved, so the holder reaches everything
// the permission covers tenant-wide. A scan-to-mail app with `Mail.Read` reads
// every mailbox. The shortlist names the permissions that grant that kind of
// reach, and a category and severity for each that an analyst can read without
// a scoring model behind it.
//
// Entries are keyed by the API's **appId**, which is the same in every tenant,
// never by the API's display name or by the permission value alone: any API may
// publish an app role called `Mail.Read`, and only Microsoft Graph's one reads
// mailboxes. A grant whose target API is not listed here is never classified,
// whatever its value says.
//
// Extending the list is adding a line to an API's `permissions` map, or an API
// with its appId. Nothing else reads these tables.

export const SEVERITY = Object.freeze({ critical: 'Critical', high: 'High' });

const CATEGORY = Object.freeze({
  sharepoint: 'SharePoint and OneDrive content',
  mail: 'Mailboxes',
  directory: 'Directory control',
});

/** @type {Record<string, { name: string, permissions: Record<string, { category: string, severity: string }> }>} */
export const HIGH_RISK_APIS = Object.freeze({
  // Microsoft Graph — the API almost every modern app talks to.
  '00000003-0000-0000-c000-000000000000': {
    name: 'Microsoft Graph',
    permissions: {
      'Sites.Read.All':        { category: CATEGORY.sharepoint, severity: SEVERITY.high },
      'Sites.ReadWrite.All':   { category: CATEGORY.sharepoint, severity: SEVERITY.critical },
      'Sites.FullControl.All': { category: CATEGORY.sharepoint, severity: SEVERITY.critical },
      'Files.Read.All':        { category: CATEGORY.sharepoint, severity: SEVERITY.high },
      'Files.ReadWrite.All':   { category: CATEGORY.sharepoint, severity: SEVERITY.critical },
      'Mail.Read':             { category: CATEGORY.mail, severity: SEVERITY.high },
      'Mail.ReadWrite':        { category: CATEGORY.mail, severity: SEVERITY.critical },
      'Mail.Send':             { category: CATEGORY.mail, severity: SEVERITY.critical },
      'Directory.ReadWrite.All':            { category: CATEGORY.directory, severity: SEVERITY.critical },
      'RoleManagement.ReadWrite.Directory': { category: CATEGORY.directory, severity: SEVERITY.critical },
      'AppRoleAssignment.ReadWrite.All':    { category: CATEGORY.directory, severity: SEVERITY.critical },
      'Application.ReadWrite.All':          { category: CATEGORY.directory, severity: SEVERITY.critical },
    },
  },
  // Office 365 SharePoint Online — the SharePoint REST/CSOM API, used by older
  // integrations instead of Graph. Its site roles are the same reach.
  '00000003-0000-0ff1-ce00-000000000000': {
    name: 'Office 365 SharePoint Online',
    permissions: {
      'Sites.Read.All':        { category: CATEGORY.sharepoint, severity: SEVERITY.high },
      'Sites.ReadWrite.All':   { category: CATEGORY.sharepoint, severity: SEVERITY.critical },
      'Sites.FullControl.All': { category: CATEGORY.sharepoint, severity: SEVERITY.critical },
    },
  },
  // Office 365 Exchange Online — EWS and the Exchange management API. Both of
  // these reach every mailbox; `full_access_as_app` is the one scan-to-mail and
  // archiving products ask for.
  '00000002-0000-0ff1-ce00-000000000000': {
    name: 'Office 365 Exchange Online',
    permissions: {
      'full_access_as_app':   { category: CATEGORY.mail, severity: SEVERITY.critical },
      'Exchange.ManageAsApp': { category: CATEGORY.mail, severity: SEVERITY.critical },
    },
  },
  // Azure Active Directory Graph (retired, but grants on it still exist).
  '00000002-0000-0000-c000-000000000000': {
    name: 'Azure Active Directory Graph',
    permissions: {
      'Directory.ReadWrite.All': { category: CATEGORY.directory, severity: SEVERITY.critical },
    },
  },
});

// ─── Granted application permissions, shared by the report and its picker ───

// Every live app-only grant: an ApplicationPermission resource with a Direct
// assignment whose principal is the holding SP. The target API is identified
// by appId — stamped on the resource by the crawler, or, for data crawled
// before it was, read from the API's own service-principal record.
export const GRANTS_FROM = `
        FROM "ResourceAssignments" ra
        JOIN "Resources" ap ON ap.id = ra."resourceId"
                           AND ap."resourceType" = 'ApplicationPermission'
                           AND ap."deletedAt" IS NULL
        LEFT JOIN "Principals" tsp ON tsp.id::text = ap."extendedAttributes"->>'targetApiSpId'
                                  AND tsp."principalType" IN ('ServicePrincipal', 'ManagedIdentity', 'AIAgent')
                                  AND tsp."deletedAt" IS NULL`;
export const GRANTS_WHERE = `ra."deletedAt" IS NULL AND ra."assignmentType" = 'Direct'`;
export const API_APP_ID_SQL = `COALESCE(ap."extendedAttributes"->>'targetApiAppId', tsp."extendedAttributes"->>'appId')`;

// A picked permission is stored as "<apiAppId>|<permission>". The API is part
// of the key for the same reason the shortlist is keyed by it: the value alone
// does not say which API issued it. A pipe, because report parameters travel
// comma-joined; neither an appId nor a permission value contains one.
const KEY_SEPARATOR = '|';
const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function permissionKey(apiAppId, permission) {
  return `${String(apiAppId).toLowerCase()}${KEY_SEPARATOR}${permission}`;
}

/** The parts of a stored key, or null when it is not one (typed by hand, say). */
export function parsePermissionKey(key) {
  const text = String(key ?? '');
  const at = text.indexOf(KEY_SEPARATOR);
  if (at < 0) return null;
  const apiAppId = text.slice(0, at).trim().toLowerCase();
  const permission = text.slice(at + 1).trim();
  return APP_ID.test(apiAppId) && permission ? { apiAppId, permission } : null;
}

/** True when the grant is on the shortlist — what the picker marks as standard. */
export function isStandardPermission(apiAppId, permission) {
  return classifyAppPermission({ targetApiAppId: apiAppId, permission }) !== null;
}

/** The shortlist's name for an API, when it has one. */
export function knownApiName(apiAppId) {
  return HIGH_RISK_APIS[String(apiAppId ?? '').toLowerCase()]?.name ?? null;
}

/**
 * Classify one granted application permission.
 * @param {{ targetApiAppId?: string|null, permission?: string|null }} grant
 * @returns {{ api: string, category: string, severity: string } | null}
 *   null when the target API is unknown or not listed, or the permission is not
 *   on that API's shortlist — the grant is then not high-risk *by this list*.
 */
export function classifyAppPermission({ targetApiAppId, permission }) {
  if (!targetApiAppId || !permission) return null;
  const api = HIGH_RISK_APIS[String(targetApiAppId).toLowerCase()];
  const entry = api?.permissions[permission];
  return entry ? { api: api.name, category: entry.category, severity: entry.severity } : null;
}
