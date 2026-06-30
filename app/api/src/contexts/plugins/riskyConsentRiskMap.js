// Curated risk classification for Microsoft Graph (and similar) OAuth permissions.
//
// Why a curated map instead of Microsoft's own classification API: Entra's
// `delegatedPermissionClassifications` only covers low-impact, no-admin-consent
// DELEGATED permissions — it deliberately can't classify the dangerous
// application / admin-consent permissions (Group.ReadWrite.All, Mail.Send,
// RoleManagement.ReadWrite.Directory, …), which are exactly the consents a
// security team wants to hunt. So we ship our own tiering, seeded from the
// well-known dangerous set plus common Graph scopes, and fall back to patterns
// for anything unlisted.
//
// Tiers: 'High' (broad write / privileged / send-as), 'Medium' (broad read or
// scoped write), 'Low' (sign-in basics, self scopes). Exact matches win; then
// suffix patterns; then `unknownTier` (default 'Low').
//
// Keep this list pulling its weight, not exhaustive — the pattern fallback
// catches the long tail (`*.ReadWrite.All` → High, `*.Read.All` → Medium, …).

export const HIGH_RISK = new Set([
  'RoleManagement.ReadWrite.Directory',
  'RoleManagement.ReadWrite.Exchange',
  'AppRoleAssignment.ReadWrite.All',
  'Application.ReadWrite.All',
  'Application.ReadWrite.OwnedBy',
  'Directory.ReadWrite.All',
  'Domain.ReadWrite.All',
  'Group.ReadWrite.All',
  'GroupMember.ReadWrite.All',
  'User.ReadWrite.All',
  'Mail.ReadWrite',
  'Mail.ReadWrite.All',
  'Mail.Send',
  'Mail.Send.All',
  'MailboxSettings.ReadWrite',
  'EWS.AccessAsUser.All',   // full mailbox access via Exchange Web Services
  'EAS.AccessAsUser.All',   // full mailbox access via Exchange ActiveSync
  'Files.ReadWrite.All',
  'Sites.ReadWrite.All',
  'Sites.Manage.All',
  'Sites.FullControl.All',
  'full_access_as_user',
  'PrivilegedAccess.ReadWrite.AzureAD',
  'PrivilegedAccess.ReadWrite.AzureADGroup',
  'Policy.ReadWrite.ConditionalAccess',
  'DeviceManagementConfiguration.ReadWrite.All',
  'DeviceManagementManagedDevices.ReadWrite.All',
]);

export const MEDIUM_RISK = new Set([
  'Directory.Read.All',
  'Directory.AccessAsUser.All',
  'Group.Read.All',
  'GroupMember.Read.All',
  'User.Read.All',
  'User.ReadBasic.All',
  'Application.Read.All',
  'AuditLog.Read.All',
  'Mail.Read',
  'Files.Read.All',
  'Sites.Read.All',
  'People.Read.All',
  'Calendars.ReadWrite',
  'Calendars.ReadWrite.Shared',
  'Contacts.ReadWrite',
  'Chat.ReadWrite',
  'ChannelMessage.Read.All',
]);

export const LOW_RISK = new Set([
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Calendars.Read',
  'Contacts.Read',
  'Mail.ReadBasic',
]);

const VALID_TIERS = new Set(['High', 'Medium', 'Low']);

/**
 * Classify a single permission string (a delegated scope like 'Calendars.ReadWrite'
 * or an application appRoleValue like 'Group.ReadWrite.All') into a risk tier.
 * @param {string} permission
 * @param {{unknownTier?: 'High'|'Medium'|'Low'}} [opts]
 * @returns {'High'|'Medium'|'Low'}
 */
export function classifyPermission(permission, opts = {}) {
  const unknownTier = VALID_TIERS.has(opts.unknownTier) ? opts.unknownTier : 'Low';
  if (!permission || typeof permission !== 'string') return unknownTier;
  const p = permission.trim();
  if (!p) return unknownTier;

  if (HIGH_RISK.has(p)) return 'High';
  if (MEDIUM_RISK.has(p)) return 'Medium';
  if (LOW_RISK.has(p)) return 'Low';

  // Suffix patterns for the long tail (case-insensitive).
  if (/\.(ReadWrite|FullControl|Manage)\.All$/i.test(p)) return 'High';
  if (/\.ReadWrite\.OwnedBy$/i.test(p)) return 'High';
  if (/\.Read\.All$/i.test(p)) return 'Medium';
  if (/\.ReadWrite(\.Shared)?$/i.test(p)) return 'Medium';

  return unknownTier;
}
