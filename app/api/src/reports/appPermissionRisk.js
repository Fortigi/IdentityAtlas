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
