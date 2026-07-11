// Live discovery handler for the Entra ID crawler wizard.
//
// Loaded dynamically by the generic POST /admin/crawlers/:type/discover
// endpoint in routes/jobs.js. Dependencies are injected via the third
// argument so this file has no hard-coded paths into the API source tree.
//
// handler(req, res, { db, getConfigSecret })
//   db              — app/api/src/db/connection.js pool wrapper
//   getConfigSecret — app/api/src/secrets/crawlerSecrets.js vault reader
//
// Branches on req.body.type:
//   'validate' — acquire a token + check granted Graph app-role permissions.
//                Always receives explicit { config: { tenantId, clientId, clientSecret } } —
//                the wizard skips validation client-side in edit mode when no new
//                secret was entered, so this branch never sees a bare configId.
//   'users' | 'groups' — sample a Graph object + discover its attributes.
//                Accepts either { config: {...} } (fresh credentials) or
//                { configId } (edit mode) — the configId path resolves
//                clientSecret via getConfigSecret since it is stripped from
//                the stored config JSON on every save.

// Graph API permission IDs → human-readable names.
//
// IDs verified against the live Microsoft Graph service principal
// (00000003-0000-0000-c000-000000000000) appRoles list — do NOT trust the
// docs pages, they occasionally print delegated-scope IDs by mistake. When
// adding a new permission, verify with:
//   GET /v1.0/servicePrincipals(appId='00000003-0000-0000-c000-000000000000')?$select=appRoles
//
// For each required permission we also list any *superset* app-role that
// should count as "granted" — e.g. AccessReview.ReadWrite.All implies
// AccessReview.Read.All, so an admin who granted the broader one shouldn't
// see a red ✗ next to Read.All.
const GRAPH_PERMISSION_MAP = {
  // id → canonical name
  'df021288-bdef-4463-88db-98f22de89214': 'User.Read.All',
  '5b567255-7703-4780-807c-7be8301ae99b': 'Group.Read.All',
  '98830695-27a2-44f7-8c18-0c3ebc9698f6': 'GroupMember.Read.All',
  '7ab1d382-f21e-4acd-a863-ba3e13f7da61': 'Directory.Read.All',
  '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30': 'Application.Read.All',
  // PrivilegedEligibilitySchedule.Read.AzureADGroup — previous ID
  // (b3a539c9-59be-4c8d-b62c-11ae8c4f2a37) was the delegated scope id, not the
  // application app-role id. That's why the wizard kept showing the PIM
  // permission as ungranted even when it had been consented. Fixed 2026-04-11.
  'edb419d6-7edc-42a3-9345-509bfdf5d87c': 'PrivilegedEligibilitySchedule.Read.AzureADGroup',
  'c74fd47d-ed3c-45c3-9a9e-b8676de685d2': 'EntitlementManagement.Read.All',
  'd07a8cc0-3d51-4b77-b3b0-32704d1f69fa': 'AccessReview.Read.All',
  'b0afded3-3588-46d8-8b3d-9842eff778da': 'AuditLog.Read.All',
  // DelegatedPermissionGrant.Read.All — required to read /oauth2PermissionGrants
  // so the crawler can ingest per-user delegated consents (user authorized app
  // X to read their mail on their behalf). Directory.Read.All is NOT sufficient.
  '81b4724a-58aa-41c1-8a55-84ef97466587': 'DelegatedPermissionGrant.Read.All',
  // Role-management / PIM directory. Not strictly required but nice to surface
  // so the admin can see whether PIM-for-roles is available to the crawler.
  '483bed4a-2ad3-4361-a73b-c83ccdbdc53c': 'RoleManagement.Read.Directory',
  'ff278e11-4a33-4d0c-83d2-d01dc58929a5': 'RoleEligibilitySchedule.Read.Directory',
};

// Supersets — if the admin consented to the broader permission, the narrower
// one should count as granted. The key is an app-role id the admin might have
// consented to, the value is the canonical name of the *implied* narrower
// permission. Applied when computing the `permissions` response.
const GRAPH_PERMISSION_ALIASES = {
  // AccessReview.ReadWrite.All → AccessReview.Read.All
  'ef5f7d5c-338f-44b0-86c3-351f46c8bb5f': 'AccessReview.Read.All',
  // Directory.ReadWrite.All → Directory.Read.All
  '19dbc75e-c2e2-444c-a770-ec69d8559fc7': 'Directory.Read.All',
  // Group.ReadWrite.All → Group.Read.All
  '62a82d76-70ea-41e2-9197-370581804d09': 'Group.Read.All',
  // GroupMember.ReadWrite.All → GroupMember.Read.All
  'dbaae8cf-10b5-4b86-a4a1-f871c94c6695': 'GroupMember.Read.All',
  // User.ReadWrite.All → User.Read.All
  '741f803b-c850-494e-b5df-cde7c675a1ca': 'User.Read.All',
  // Application.ReadWrite.All → Application.Read.All
  '1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9': 'Application.Read.All',
  // EntitlementManagement.ReadWrite.All → EntitlementManagement.Read.All
  '9acd699f-1e81-4958-b001-93b1d2506e19': 'EntitlementManagement.Read.All',
  // RoleManagement.ReadWrite.Directory → RoleManagement.Read.Directory
  '9e3f62cf-ca93-4989-b6ce-bf83c28f9fe8': 'RoleManagement.Read.Directory',
  // DelegatedPermissionGrant.ReadWrite.All → DelegatedPermissionGrant.Read.All
  '41ce6ca6-6826-4807-84f1-1c82854f7ee5': 'DelegatedPermissionGrant.Read.All',
};

// Which permissions enable which object types
const PERMISSION_OBJECT_MAP = {
  'User.Read.All': ['identity', 'usersGroupsMembers'],
  'Group.Read.All': ['usersGroupsMembers'],
  'GroupMember.Read.All': ['usersGroupsMembers'],
  'Directory.Read.All': ['directoryRoles', 'servicePrincipals'],
  'Application.Read.All': ['appsAppRoles', 'appOwners', 'appPermissions', 'servicePrincipals'],
  'PrivilegedEligibilitySchedule.Read.AzureADGroup': ['pim'],
  'EntitlementManagement.Read.All': ['identityGovernance'],
  'AccessReview.Read.All': ['identityGovernance'],
  'AuditLog.Read.All': ['identity', 'signInLogs'],
  'RoleManagement.Read.Directory': ['directoryRoles'],
  'RoleEligibilitySchedule.Read.Directory': ['pim'],
  'DelegatedPermissionGrant.Read.All': ['oauth2Grants'],
};

// All known object types for the Entra ID crawler.
// Context generation (formerly an Entra crawler object type) is no longer
// crawler-driven — it's produced by Contexts → plugin runs after the crawl
// (manager-hierarchy, department-tree, ad-ou-from-dn). See
// docs/architecture/context-redesign.md.
const ENTRA_OBJECT_TYPES = [
  { key: 'identity', label: 'Identity', description: 'Personal user accounts that are synced from HR' },
  { key: 'usersGroupsMembers', label: 'Users & Groups & Members', description: 'All users, security groups, and group memberships' },
  { key: 'servicePrincipals', label: 'Service Principals', description: 'Non-human identities (enterprise app SPs, managed identities, AI agents)' },
  { key: 'identityGovernance', label: 'Identity Governance', description: 'Access Packages, assignments, policies, reviews' },
  { key: 'appsAppRoles', label: 'Apps & AppRoles', description: 'Application registrations and role assignments' },
  { key: 'appOwners', label: 'App Owners', description: 'Owners of app registrations (who can add credentials and impersonate the app) and enterprise-app service principals' },
  { key: 'appPermissions', label: 'Application Permissions', description: 'App-only permissions each service principal / managed identity / AI agent holds on other APIs (e.g. Mail.Read on Microsoft Graph) — the admin-consented, tenant-wide kind' },
  { key: 'principalRelationships', label: 'Agent Owners & Guest Sponsors', description: 'Owners of AI agents and sponsors of guest accounts — the person accountable for each non-human / external identity, shown on its relations tab' },
  { key: 'directoryRoles', label: 'Directory Roles', description: 'Entra ID directory role assignments' },
  { key: 'pim', label: 'PIM', description: 'Privileged Identity Management eligible group memberships' },
  { key: 'signInLogs', label: 'Sign-in Logs (per-app activity)', description: 'Aggregated sign-in events — last activity per (user, app) pair' },
  { key: 'oauth2Grants', label: 'OAuth2 Delegated Grants', description: 'Per-user consent grants (user X allowed app Y to call API Z with scope W). Tenant-wide consents are skipped.' },
];

// Comprehensive list of well-known Graph user/group attributes (used to widen $select)
// Excludes SharePoint-dependent fields (mySite, aboutMe, interests, etc.) which require an SPO license.
const KNOWN_USER_ATTRS = [
  'id','displayName','givenName','surname','userPrincipalName','mail','mailNickname',
  'accountEnabled','userType','createdDateTime','deletedDateTime','externalUserState',
  'department','jobTitle','companyName','employeeId','employeeType','employeeHireDate',
  'employeeLeaveDateTime','employeeOrgData',
  'businessPhones','mobilePhone','faxNumber','otherMails','proxyAddresses',
  'usageLocation','country','city','state','postalCode','streetAddress','officeLocation',
  'preferredLanguage','ageGroup','consentProvidedForMinor',
  'onPremisesSyncEnabled','onPremisesDistinguishedName','onPremisesSamAccountName',
  'onPremisesDomainName','onPremisesUserPrincipalName','onPremisesImmutableId',
  'onPremisesSecurityIdentifier','onPremisesLastSyncDateTime',
  'onPremisesExtensionAttributes','imAddresses','identities',
  'signInSessionsValidFromDateTime','passwordPolicies',
];

const KNOWN_GROUP_ATTRS = [
  'id','displayName','description','mail','mailNickname','mailEnabled','securityEnabled',
  'visibility','createdDateTime','deletedDateTime','expirationDateTime','renewedDateTime',
  'groupTypes','membershipRule','membershipRuleProcessingState',
  'classification','isAssignableToRole',
  'preferredLanguage','preferredDataLocation','theme','proxyAddresses',
  'onPremisesSyncEnabled','onPremisesDistinguishedName','onPremisesDomainName',
  'onPremisesNetBiosName','onPremisesSamAccountName','onPremisesSecurityIdentifier',
  'onPremisesLastSyncDateTime','securityIdentifier',
];

// Flatten onPremisesExtensionAttributes to top-level extensionAttributeN
function flattenExtensionAttributes(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const flat = { ...obj };
  if (flat.onPremisesExtensionAttributes && typeof flat.onPremisesExtensionAttributes === 'object') {
    for (const [k, v] of Object.entries(flat.onPremisesExtensionAttributes)) {
      flat[k] = v;
    }
  }
  return flat;
}

// Acquire a Graph access token via client-credentials. Throws on failure —
// callers that need a soft `{valid:false}` response catch and unwrap err.message.
async function acquireGraphToken({ tenantId, clientId, clientSecret }) {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.error || 'Token acquisition failed');
  }
  const data = await res.json();
  return data.access_token;
}

// ─── 'validate' ───────────────────────────────────────────────────────────────

async function handleValidate(req, res) {
  const { tenantId, clientId, clientSecret } = req.body.config || {};
  if (!tenantId || !clientId || !clientSecret) {
    return res.status(400).json({ error: 'tenantId, clientId, and clientSecret are required' });
  }

  try {
    const accessToken = await acquireGraphToken({ tenantId, clientId, clientSecret });

    let organization = null;
    const orgRes = await fetch('https://graph.microsoft.com/v1.0/organization', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (orgRes.ok) {
      const orgData = await orgRes.json();
      if (orgData.value?.[0]) organization = orgData.value[0].displayName;
    }

    // Get granted permissions via service principal's appRoleAssignments
    const permissions = {};
    for (const name of Object.values(GRAPH_PERMISSION_MAP)) permissions[name] = false;

    try {
      const spRes = await fetch(
        `https://graph.microsoft.com/v1.0/servicePrincipals(appId='${encodeURIComponent(clientId)}')`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (spRes.ok) {
        const sp = await spRes.json();

        // Walk paginated appRoleAssignments — Graph can return fewer than the
        // full set per page. Follow @odata.nextLink to be safe.
        let url = `https://graph.microsoft.com/v1.0/servicePrincipals/${sp.id}/appRoleAssignments?$top=999`;
        const allAssignments = [];
        while (url) {
          const page = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!page.ok) break;
          const data = await page.json();
          for (const a of data.value || []) allAssignments.push(a);
          url = data['@odata.nextLink'] || null;
        }

        for (const a of allAssignments) {
          const direct = GRAPH_PERMISSION_MAP[a.appRoleId];
          if (direct) { permissions[direct] = true; continue; }
          const alias = GRAPH_PERMISSION_ALIASES[a.appRoleId];
          if (alias && permissions[alias] !== undefined) permissions[alias] = true;
        }
      }
    } catch (err) {
      // Permission check failed — credentials work but we couldn't read the
      // SP's roles. Fall through with permissions all false rather than
      // failing the wizard step.
      console.warn('appRoleAssignments lookup failed:', err.message);
    }

    res.json({
      valid: true,
      organization,
      permissions,
      objectTypes: ENTRA_OBJECT_TYPES,
      permissionObjectMap: PERMISSION_OBJECT_MAP,
    });
  } catch (err) {
    res.json({ valid: false, error: err.message.split('\r\n')[0] });
  }
}

// ─── 'users' | 'groups' ─────────────────────────────────────────────────────

async function handleDiscoverAttributes(req, res, { db, getConfigSecret }) {
  const { type, configId, config: inlineConfig } = req.body;

  let tenantId, clientId, clientSecret;
  if (configId != null) {
    try {
      const id = parseInt(configId, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'configId must be a number' });
      const row = await db.queryOne(`SELECT config FROM "CrawlerConfigs" WHERE id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'Config not found' });
      const cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
      tenantId = cfg.tenantId;
      clientId = cfg.clientId;
      // clientSecret lives in the vault, not in the stored JSON — fetch it.
      clientSecret = cfg.clientSecret || await getConfigSecret(id);
    } catch (err) {
      console.error('entra-id/discover config lookup error:', err.message);
      return res.status(500).json({ error: 'Failed to load config' });
    }
  } else if (inlineConfig && typeof inlineConfig === 'object') {
    tenantId = inlineConfig.tenantId;
    clientId = inlineConfig.clientId;
    clientSecret = inlineConfig.clientSecret;
  } else {
    return res.status(400).json({ error: 'configId or config required' });
  }

  if (!tenantId || !clientId || !clientSecret) {
    return res.status(400).json({ error: 'Credentials required (or pass configId)' });
  }

  try {
    const accessToken = await acquireGraphToken({ tenantId, clientId, clientSecret });
    const knownAttrs = type === 'users' ? KNOWN_USER_ATTRS : KNOWN_GROUP_ATTRS;
    const select = knownAttrs.join(',');

    // Fetch one sample object with the wide $select (known attributes)
    const url = `https://graph.microsoft.com/beta/${type}?$top=1&$select=${select}`;
    const sampleRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    if (!sampleRes.ok) {
      const err = await sampleRes.json().catch(() => ({}));
      return res.status(400).json({
        error: `Graph API error: ${err.error?.message || sampleRes.statusText}`,
      });
    }

    const data = await sampleRes.json();
    const sample = data.value?.[0];

    // Build attribute list:
    // - Known attrs are always included (some may be null in sample)
    // - Sample non-null keys (in case Graph returns additional fields)
    // - Flatten extensionAttribute1-15 from onPremisesExtensionAttributes
    // - Schema extensions (extension_<appId>_<name>) are NOT returned when $select is used
    //   so we do a second call WITHOUT $select to discover them, then merge
    const flat = sample ? flattenExtensionAttributes(sample) : {};
    const sampleKeys = new Set(Object.keys(flat));

    // Always include extensionAttribute1-15 for users (they live in onPremisesExtensionAttributes)
    if (type === 'users') {
      for (let i = 1; i <= 15; i++) sampleKeys.add(`extensionAttribute${i}`);
    }

    // Discover schema extensions / directory extensions targeted at the current type.
    // Four sources, all run in parallel for speed:
    //   1. /schemaExtensions — modern schema extensions (extension_<appId>_<name>)
    //   2. /directoryObjects/getAvailableExtensionProperties — directory extensions
    //      (covers both synced-from-on-prem and manually-defined). Runs TWICE.
    //   3. /applications + /extensionProperties — most reliable source, parallelized
    //   4. Sample fetch without $select — used only to infer dataType from values
    //
    // We capture each extension's dataType ("Boolean", "String", "Integer", etc.) so
    // the UI can render the right input control (e.g. true/false dropdown for booleans).
    const dataTypes = {};          // attr → 'Boolean' | 'String' | 'Integer' | ...
    const targetTypeForExt = type === 'users' ? 'User' : 'Group';

    // Map Graph API dataType strings to a normalised set the UI uses
    const normaliseType = (t) => {
      if (!t) return undefined;
      const s = String(t).toLowerCase();
      if (s.includes('bool')) return 'Boolean';
      if (s.includes('int')) return 'Integer';
      if (s.includes('date')) return 'DateTime';
      if (s.includes('string')) return 'String';
      return t;
    };

    const extPromises = [];

    // Source 1: Schema extensions (newer-style)
    extPromises.push(
      fetch(
        `https://graph.microsoft.com/beta/schemaExtensions?$filter=targetTypes/any(t:t eq '${targetTypeForExt}')`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
        .then(r => r.ok ? r.json() : null)
        .then(seData => {
          for (const ext of (seData?.value || [])) {
            if (ext.id) sampleKeys.add(ext.id);
            for (const prop of (ext.properties || [])) {
              if (!prop.name) continue;
              const fullKey = `${ext.id}_${prop.name}`;
              sampleKeys.add(fullKey);
              if (prop.type) dataTypes[fullKey] = normaliseType(prop.type);
            }
          }
        })
        .catch(() => {})
    );

    // Source 2a + 2b: getAvailableExtensionProperties (synced and non-synced)
    for (const isSynced of [true, false]) {
      extPromises.push(
        fetch(
          `https://graph.microsoft.com/beta/directoryObjects/getAvailableExtensionProperties`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ isSyncedFromOnPremises: isSynced }),
          }
        )
          .then(r => r.ok ? r.json() : null)
          .then(epData => {
            for (const prop of (epData?.value || [])) {
              const targets = prop.targetObjects || [];
              if (targets.length === 0 || targets.includes(targetTypeForExt)) {
                if (!prop.name) continue;
                sampleKeys.add(prop.name);
                if (prop.dataType) dataTypes[prop.name] = normaliseType(prop.dataType);
              }
            }
          })
          .catch(() => {})
      );
    }

    // Source 3: enumerate all app registrations and read their extensionProperties
    // in PARALLEL. getAvailableExtensionProperties (source 2) misses some extensions
    // in many tenants, so we also walk the apps directly. This is the most reliable
    // source — it lists every directory extension defined in the tenant.
    extPromises.push(
      fetch(
        'https://graph.microsoft.com/beta/applications?$select=id,displayName&$top=999',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
        .then(r => r.ok ? r.json() : null)
        .then(async (appsData) => {
          const apps = appsData?.value || [];
          // Fetch extensionProperties for all apps in parallel (chunked to avoid rate limiting)
          const CHUNK = 20;
          for (let i = 0; i < apps.length; i += CHUNK) {
            const chunk = apps.slice(i, i + CHUNK);
            await Promise.all(chunk.map(app =>
              fetch(`https://graph.microsoft.com/beta/applications/${app.id}/extensionProperties`,
                { headers: { Authorization: `Bearer ${accessToken}` } })
                .then(r => r.ok ? r.json() : null)
                .then(propsData => {
                  for (const prop of (propsData?.value || [])) {
                    const targets = prop.targetObjects || [];
                    if (targets.length === 0 || targets.includes(targetTypeForExt)) {
                      if (!prop.name) continue;
                      sampleKeys.add(prop.name);
                      if (prop.dataType) dataTypes[prop.name] = normaliseType(prop.dataType);
                    }
                  }
                })
                .catch(() => {})
            ));
          }
        })
        .catch(() => {})
    );

    // Source 4: sample fetch without $select. Used only to (a) discover any
    // extensions returned by default that the schema endpoints missed, and
    // (b) infer dataType from a real value when sources 1-3 didn't provide one.
    extPromises.push(
      fetch(`https://graph.microsoft.com/beta/${type}?$top=10`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
        .then(r => r.ok ? r.json() : null)
        .then(sampleData => {
          for (const obj of (sampleData?.value || [])) {
            for (const key of Object.keys(obj)) {
              if (/^extension_[0-9a-f]{32}_/i.test(key) || key.startsWith('extension_')) {
                sampleKeys.add(key);
                const v = obj[key];
                // Infer type from sample value only if we don't already know it
                if (v !== null && v !== undefined && v !== '' && !dataTypes[key]) {
                  if (typeof v === 'boolean') dataTypes[key] = 'Boolean';
                  else if (typeof v === 'number') dataTypes[key] = Number.isInteger(v) ? 'Integer' : 'Number';
                  else if (typeof v === 'string') {
                    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) dataTypes[key] = 'DateTime';
                    else dataTypes[key] = 'String';
                  }
                }
              }
            }
          }
        })
        .catch(() => {})
    );

    // Wait for all parallel discoveries to finish
    await Promise.all(extPromises);

    // Combine known + sample, exclude internal/odata fields
    const all = new Set([...knownAttrs, ...sampleKeys]);
    const attributes = Array.from(all)
      .filter(a => !a.startsWith('@') && a !== 'onPremisesExtensionAttributes' && a !== 'id')
      .sort();

    res.json({
      type,
      attributes,
      dataTypes,
      sampleId: sample?.id || null,
    });
  } catch (err) {
    console.error('entra-id/discover error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export default async function handler(req, res, ctx) {
  const { type } = req.body || {};
  if (type === 'validate') return handleValidate(req, res);
  if (type === 'users' || type === 'groups') return handleDiscoverAttributes(req, res, ctx);
  return res.status(400).json({ error: 'type must be "validate", "users", or "groups"' });
}
