/**
 * Crawler job management + crawler configuration endpoints.
 * Jobs are stored in CrawlerJobs and picked up by the worker container.
 * Configs are stored in CrawlerConfigs for persistent crawler settings.
 */
import { Router } from 'express';
import * as db from '../db/connection.js';
import { existsSync, readdirSync } from 'fs';
import { getCsvFolderPath, deleteConfigFolder } from './csvUploads.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

const VALID_JOB_TYPES = ['demo', 'entra-id', 'csv'];
const MAX_RECENT_JOBS = 50;
const SECRET_MASK = '••••••••';

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
};

// Which permissions enable which object types
const PERMISSION_OBJECT_MAP = {
  'User.Read.All': ['identity', 'context', 'usersGroupsMembers'],
  'Group.Read.All': ['usersGroupsMembers'],
  'GroupMember.Read.All': ['usersGroupsMembers'],
  'Directory.Read.All': ['directoryRoles', 'servicePrincipals'],
  'Application.Read.All': ['appsAppRoles', 'servicePrincipals'],
  'PrivilegedEligibilitySchedule.Read.AzureADGroup': ['pim'],
  'EntitlementManagement.Read.All': ['identityGovernance'],
  'AccessReview.Read.All': ['identityGovernance'],
  'AuditLog.Read.All': ['identity', 'signInLogs'],
  'RoleManagement.Read.Directory': ['directoryRoles'],
  'RoleEligibilitySchedule.Read.Directory': ['pim'],
};

// All known object types for the Entra ID crawler
const ENTRA_OBJECT_TYPES = [
  { key: 'identity', label: 'Identity', description: 'Personal user accounts that are synced from HR' },
  { key: 'context', label: 'Context', description: 'Auto-detected organizational structure from identity data' },
  { key: 'usersGroupsMembers', label: 'Users & Groups & Members', description: 'All users, security groups, and group memberships' },
  { key: 'servicePrincipals', label: 'Service Principals', description: 'Non-human identities (enterprise app SPs, managed identities, AI agents)' },
  { key: 'identityGovernance', label: 'Identity Governance', description: 'Access Packages, assignments, policies, reviews' },
  { key: 'appsAppRoles', label: 'Apps & AppRoles', description: 'Application registrations and role assignments' },
  { key: 'directoryRoles', label: 'Directory Roles', description: 'Entra ID directory role assignments' },
  { key: 'pim', label: 'PIM', description: 'Privileged Identity Management eligible group memberships' },
  { key: 'signInLogs', label: 'Sign-in Logs (per-app activity)', description: 'Aggregated sign-in events — last activity per (user, app) pair' },
];

function maskConfig(config) {
  if (!config) return null;
  const parsed = typeof config === 'string' ? JSON.parse(config) : config;
  const masked = { ...parsed };
  if (masked.clientSecret) masked.clientSecret = SECRET_MASK;
  return masked;
}

// ═══════════════════════════════════════════════════════════════════
// CRAWLER CONFIGS — Persistent crawler configurations
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/crawler-configs — List all configs (secrets masked)
router.get('/admin/crawler-configs', async (req, res) => {
  if (!useSql) return res.json([]);
  try {
    const pool = await db.getPool();
    const result = await pool.request().query(
      `SELECT * FROM "CrawlerConfigs" WHERE "enabled" = TRUE ORDER BY "createdAt" DESC`
    );
    const configs = result.recordset.map(r => ({
      ...r,
      config: maskConfig(r.config),
    }));
    res.json(configs);
  } catch (err) {
    console.error('Error listing crawler configs:', err.message);
    res.status(500).json({ error: 'Failed to list configs' });
  }
});

// POST /api/admin/crawler-configs — Create a new config
router.post('/admin/crawler-configs', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const { crawlerType, displayName, config } = req.body;

  if (!crawlerType || !displayName?.trim()) {
    return res.status(400).json({ error: 'crawlerType and displayName are required' });
  }

  try {
    const pool = await db.getPool();
    const result = await pool.request()
      .input('crawlerType', crawlerType)
      .input('displayName', displayName.trim().slice(0, 255))
      .input('config', JSON.stringify(config || {}))
      .query(`INSERT INTO "CrawlerConfigs" ("crawlerType", "displayName", config)
              VALUES (@crawlerType, @displayName, @config)
              RETURNING *`);

    const row = result.recordset[0];
    res.status(201).json({ ...row, config: maskConfig(row.config) });
  } catch (err) {
    console.error('Error creating crawler config:', err.message);
    res.status(500).json({ error: 'Failed to create config' });
  }
});

// GET /api/admin/crawler-configs/:id — Single config (secret masked)
router.get('/admin/crawler-configs/:id', async (req, res) => {
  if (!useSql) return res.status(404).json({ error: 'Not found' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid config ID' });

  try {
    const pool = await db.getPool();
    const result = await pool.request().input('id', id)
      .query(`SELECT * FROM "CrawlerConfigs" WHERE id = @id`);
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Config not found' });
    const row = result.recordset[0];
    res.json({ ...row, config: maskConfig(row.config) });
  } catch (err) {
    console.error('Error fetching crawler config:', err.message);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// PATCH /api/admin/crawler-configs/:id — Update config
router.patch('/admin/crawler-configs/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid config ID' });

  const { displayName, config } = req.body;

  try {
    const pool = await db.getPool();

    // Read existing config to preserve secret if not provided
    const existing = await pool.request().input('id', id)
      .query(`SELECT config FROM "CrawlerConfigs" WHERE id = @id`);
    if (existing.recordset.length === 0) return res.status(404).json({ error: 'Config not found' });

    let mergedConfig = (typeof existing.recordset[0].config === "string" ? JSON.parse(existing.recordset[0].config) : existing.recordset[0].config);
    if (config) {
      const incoming = { ...config };
      // If secret is the mask or empty, keep existing
      if (!incoming.clientSecret || incoming.clientSecret === SECRET_MASK) {
        incoming.clientSecret = mergedConfig.clientSecret;
      }
      mergedConfig = { ...mergedConfig, ...incoming };
    }

    const sets = ['config = @config', 'updatedAt = now()'];
    const request = pool.request().input('id', id).input('config', JSON.stringify(mergedConfig));

    if (displayName !== undefined) {
      sets.push('"displayName" = @displayName');
      request.input('displayName', displayName.trim().slice(0, 255));
    }

    const result = await request.query(
      `UPDATE "CrawlerConfigs" SET ${sets.join(', ')} WHERE id = @id RETURNING *`
    );
    const row = result.recordset[0];
    res.json({ ...row, config: maskConfig(row.config) });
  } catch (err) {
    console.error('Error updating crawler config:', err.message);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// DELETE /api/admin/crawler-configs/:id — Remove config
router.delete('/admin/crawler-configs/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid config ID' });

  try {
    const pool = await db.getPool();
    const result = await pool.request().input('id', id)
      .query(`DELETE FROM "CrawlerConfigs" WHERE id = @id`);
    if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Config not found' });
    // Best-effort cleanup of any uploaded CSV files for this config
    deleteConfigFolder(id).catch(() => {});
    res.json({ message: 'Config removed' });
  } catch (err) {
    console.error('Error removing crawler config:', err.message);
    res.status(500).json({ error: 'Failed to remove config' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// CREDENTIAL VALIDATION — Test Graph API credentials + check permissions
// ═══════════════════════════════════════════════════════════════════

// POST /api/admin/validate-graph-credentials
router.post('/admin/validate-graph-credentials', async (req, res) => {
  const { tenantId, clientId, clientSecret } = req.body;
  if (!tenantId || !clientId || !clientSecret) {
    return res.status(400).json({ error: 'tenantId, clientId, and clientSecret are required' });
  }

  try {
    // Step 1: Acquire token
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const tokenBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.json().catch(() => ({}));
      const errorDesc = err.error_description || err.error || 'Authentication failed';
      return res.json({
        valid: false,
        error: errorDesc.split('\r\n')[0], // First line only
      });
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Step 2: Verify creds — get organization info
    const orgRes = await fetch('https://graph.microsoft.com/v1.0/organization', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    let organization = null;
    if (orgRes.ok) {
      const orgData = await orgRes.json();
      if (orgData.value?.[0]) {
        organization = orgData.value[0].displayName;
      }
    }

    // Step 3: Get granted permissions via service principal's appRoleAssignments
    const permissions = {};
    for (const name of Object.values(GRAPH_PERMISSION_MAP)) {
      permissions[name] = false;
    }

    try {
      // Find the service principal by appId
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
          // Direct match (canonical app-role id → name)
          const direct = GRAPH_PERMISSION_MAP[a.appRoleId];
          if (direct) { permissions[direct] = true; continue; }
          // Superset match (e.g. AccessReview.ReadWrite.All satisfies Read.All)
          const alias = GRAPH_PERMISSION_ALIASES[a.appRoleId];
          if (alias && permissions[alias] !== undefined) {
            permissions[alias] = true;
          }
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
    console.error('Error validating credentials:', err.message);
    res.json({ valid: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GRAPH ATTRIBUTE DISCOVERY — Query a sample object to find attributes
// ═══════════════════════════════════════════════════════════════════

// Helper: get a Graph access token from credentials or stored config
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

// POST /api/admin/discover-graph-attributes
// body: { tenantId, clientId, clientSecret, type: 'users'|'groups' }
//   OR: { configId, type }
router.post('/admin/discover-graph-attributes', async (req, res) => {
  let { tenantId, clientId, clientSecret, configId, type } = req.body;
  if (!type || !['users', 'groups'].includes(type)) {
    return res.status(400).json({ error: 'type must be "users" or "groups"' });
  }

  // Resolve credentials from configId if provided
  if (configId && useSql) {
    try {
      const pool = await db.getPool();
      const cfgRes = await pool.request().input('id', configId)
        .query(`SELECT config FROM "CrawlerConfigs" WHERE id = @id`);
      if (cfgRes.recordset.length === 0) return res.status(404).json({ error: 'Config not found' });
      const cfg = (typeof cfgRes.recordset[0].config === "string" ? JSON.parse(cfgRes.recordset[0].config) : cfgRes.recordset[0].config);
      tenantId = tenantId || cfg.tenantId;
      clientId = clientId || cfg.clientId;
      clientSecret = clientSecret || cfg.clientSecret;
    } catch (err) {
      return res.status(500).json({ error: 'Failed to load config' });
    }
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
    console.error('Error discovering attributes:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// CRAWLER JOBS — Create and manage jobs
// ═══════════════════════════════════════════════════════════════════

// POST /api/admin/crawler-jobs — Create a new job
router.post('/admin/crawler-jobs', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });

  const { jobType, config, configId } = req.body;
  if (!jobType || !VALID_JOB_TYPES.includes(jobType)) {
    return res.status(400).json({ error: `jobType must be one of: ${VALID_JOB_TYPES.join(', ')}` });
  }

  try {
    const pool = await db.getPool();
    const createdBy = req.user?.preferred_username || req.user?.name || 'ui';

    // Prevent duplicate demo jobs
    if (jobType === 'demo') {
      const dup = await pool.request().query(
        `SELECT 1 FROM "CrawlerJobs" WHERE "jobType" = 'demo' AND status IN ('queued', 'running')`
      );
      if (dup.recordset.length > 0) {
        return res.status(409).json({ error: 'A demo data job is already queued or running' });
      }
    }

    // Resolve config: from configId (stored config) or inline
    let resolvedConfig = config || null;
    if (configId) {
      const cfgResult = await pool.request().input('configId', configId)
        .query(`SELECT config FROM "CrawlerConfigs" WHERE id = @configId AND "enabled" = TRUE`);
      if (cfgResult.recordset.length === 0) {
        return res.status(404).json({ error: 'Crawler config not found' });
      }
      // jsonb is auto-parsed by pg; legacy string column may still appear in tests.
      const raw = cfgResult.recordset[0].config;
      resolvedConfig = (typeof raw === 'string') ? JSON.parse(raw) : raw;
    }

    // Validate entra-id has credentials
    if (jobType === 'entra-id') {
      if (!resolvedConfig?.tenantId || !resolvedConfig?.clientId || !resolvedConfig?.clientSecret) {
        return res.status(400).json({ error: 'Entra ID jobs require tenantId, clientId, and clientSecret' });
      }
    }

    // For CSV jobs, inject the per-config upload folder so the worker knows where
    // to read files from. The folder must already exist and contain at least one file.
    if (jobType === 'csv') {
      if (!configId) {
        return res.status(400).json({ error: 'CSV jobs require a configId — inline configs are not supported' });
      }
      // Use the config's stored csvFolder if it exists (e.g. pointing to a
      // pre-transformed folder), otherwise fall back to the standard upload path.
      const configCsvFolder = resolvedConfig?.csvFolder;
      const folder = configCsvFolder && existsSync(configCsvFolder) ? configCsvFolder : getCsvFolderPath(configId);
      if (!existsSync(folder) || readdirSync(folder).length === 0) {
        return res.status(400).json({ error: 'No CSV files found. Upload files or configure the CSV folder path.' });
      }
      resolvedConfig = { ...(resolvedConfig || {}), csvFolder: folder };
    }

    // Stamp the source config id into the stored job config so the UI can
    // tell WHICH config is running when two configs of the same crawlerType
    // exist. The scheduler already stamps this field on scheduled runs
    // (see scheduler.js → queueScheduledJob); we were missing the mirror on
    // manual "Run Now" requests, which made the Crawlers page render the
    // "Force Stop" button on EVERY config of that type. Workers ignore
    // unknown fields so this is non-breaking.
    const configToStore = configId
      ? { ...(resolvedConfig || {}), _scheduledByConfigId: configId }
      : resolvedConfig;
    const configJson = configToStore ? JSON.stringify(configToStore) : null;

    const result = await pool.request()
      .input('jobType', jobType)
      .input('config', configJson)
      .input('createdBy', createdBy)
      .query(`INSERT INTO "CrawlerJobs" ("jobType", config, "createdBy")
              VALUES (@jobType, @config, @createdBy)
              RETURNING *`);

    // Update lastRunAt on the source config
    if (configId) {
      await pool.request().input('configId', configId)
        .query(`UPDATE "CrawlerConfigs" SET "lastRunAt" = (now() AT TIME ZONE 'utc') WHERE id = @configId`);
    }

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    console.error('Error creating crawler job:', err.message);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// GET /api/admin/crawler-jobs — List recent jobs
router.get('/admin/crawler-jobs', async (req, res) => {
  if (!useSql) return res.json([]);

  try {
    const pool = await db.getPool();
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, MAX_RECENT_JOBS);
    const result = await pool.request()
      .input('limit', limit)
      .query(`SELECT * FROM "CrawlerJobs" ORDER BY "createdAt" DESC LIMIT @limit`);
    res.json(result.recordset);
  } catch (err) {
    console.error('Error listing crawler jobs:', err.message);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

// GET /api/admin/crawler-jobs/:id — Single job with progress
router.get('/admin/crawler-jobs/:id', async (req, res) => {
  if (!useSql) return res.status(404).json({ error: 'Not found' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid job ID' });

  try {
    const pool = await db.getPool();
    const result = await pool.request()
      .input('id', id)
      .query(`SELECT * FROM "CrawlerJobs" WHERE id = @id`);
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Job not found' });
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('Error fetching crawler job:', err.message);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// DELETE /api/admin/crawler-jobs/:id — Cancel a queued job
// DELETE /api/admin/crawler-jobs/:id — cancel a queued job
router.delete('/admin/crawler-jobs/:id', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid job ID' });

  try {
    const result = await db.query(
      `UPDATE "CrawlerJobs" SET status = 'cancelled', "completedAt" = now()
        WHERE id = $1 AND status = 'queued'`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Job not found or not in queued state' });
    }
    res.json({ message: 'Job cancelled' });
  } catch (err) {
    console.error('Error cancelling job:', err.message);
    res.status(500).json({ error: 'Failed to cancel job' });
  }
});

// POST /api/admin/crawler-jobs/:id/force-stop — force-stop a running job.
//
// This marks the job as failed in the database. The worker process will notice
// the status change on its next progress-report cycle and stop. If the worker
// has already crashed (the most common reason to use this), the job just gets
// marked failed so the UI stops showing it as running.
//
// This does NOT kill the PowerShell process — there's no clean way to do that
// from the web container. The worker's scheduler.ps1 checks job status before
// starting new work, so a force-stopped job won't block the next run.
router.post('/admin/crawler-jobs/:id/force-stop', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid job ID' });

  try {
    const result = await db.query(
      `UPDATE "CrawlerJobs"
          SET status = 'failed',
              "errorMessage" = COALESCE("errorMessage", '') || ' [Force-stopped by admin]',
              "completedAt" = now()
        WHERE id = $1 AND status IN ('running', 'queued')
        RETURNING id, status`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Job not found or already completed/failed' });
    }
    res.json({ message: 'Job force-stopped', id });
  } catch (err) {
    console.error('Error force-stopping job:', err.message);
    res.status(500).json({ error: 'Failed to force-stop job' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// SYSTEM STATUS
// ═══════════════════════════════════════════════════════════════════

// GET /api/admin/status — System status for getting-started UI
router.get('/admin/status', async (req, res) => {
  if (!useSql) {
    return res.json({ hasData: true, hasCrawlers: false, hasConfigs: false, pendingJobs: 0, runningJobs: 0 });
  }

  try {
    const pool = await db.getPool();
    // Postgres: use to_regclass() instead of INFORMATION_SCHEMA EXISTS subqueries.
    // After migrations have run all five tables exist, but we keep the safety
    // checks so a stack started before migrations don't return 500.
    const result = await pool.request().query(`
      SELECT
        CASE WHEN to_regclass('"Principals"')     IS NULL THEN 0
             WHEN (SELECT COUNT(*) FROM "Principals") > 0 THEN 1 ELSE 0 END AS "hasData",
        CASE WHEN to_regclass('"Crawlers"')       IS NULL THEN 0
             ELSE (SELECT COUNT(*)::int FROM "Crawlers" WHERE "enabled" = TRUE) END AS "crawlerCount",
        CASE WHEN to_regclass('"CrawlerConfigs"') IS NULL THEN 0
             ELSE (SELECT COUNT(*)::int FROM "CrawlerConfigs" WHERE "enabled" = TRUE) END AS "configCount",
        CASE WHEN to_regclass('"CrawlerJobs"')    IS NULL THEN 0
             ELSE (SELECT COUNT(*)::int FROM "CrawlerJobs" WHERE "status" = 'queued') END AS "pendingJobs",
        CASE WHEN to_regclass('"CrawlerJobs"')    IS NULL THEN 0
             ELSE (SELECT COUNT(*)::int FROM "CrawlerJobs" WHERE "status" = 'running') END AS "runningJobs"
    `);

    const row = result.recordset[0];
    res.json({
      hasData: row.hasData === 1,
      hasCrawlers: row.crawlerCount > 0,
      hasConfigs: row.configCount > 0,
      pendingJobs: row.pendingJobs,
      runningJobs: row.runningJobs,
    });
  } catch (err) {
    console.error('Error fetching status:', err.message);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

export default router;
