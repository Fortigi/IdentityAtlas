/**
 * Crawler job management + crawler configuration endpoints.
 * Jobs are stored in CrawlerJobs and picked up by the worker container.
 * Configs are stored in CrawlerConfigs for persistent crawler settings.
 */
import { Router } from 'express';
import * as db from '../db/connection.js';
import { existsSync, readdirSync, promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getCsvFolderPath, deleteConfigFolder } from './csvUploads.js';
import { putSecret, getSecret, deleteSecret } from '../secrets/vault.js';

const TRACE_DIR = '/data/uploads/jobs';
// Tail endpoint returns at most this many bytes per request. If the file is
// larger than offset + MAX, the client polls again with the new offset. Keeps
// any single response small enough that a ~10 MB log on a long crawl streams
// to the UI in a dozen or so polls rather than one giant payload.
const MAX_TRACE_CHUNK = 256 * 1024;  // 256 KB

const router = Router();
const useSql = process.env.USE_SQL === 'true';

const VALID_JOB_TYPES = ['demo', 'entra-id', 'csv', 'azure-devops'];
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
  'Application.Read.All': ['appsAppRoles', 'servicePrincipals'],
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
  { key: 'directoryRoles', label: 'Directory Roles', description: 'Entra ID directory role assignments' },
  { key: 'pim', label: 'PIM', description: 'Privileged Identity Management eligible group memberships' },
  { key: 'signInLogs', label: 'Sign-in Logs (per-app activity)', description: 'Aggregated sign-in events — last activity per (user, app) pair' },
  { key: 'oauth2Grants', label: 'OAuth2 Delegated Grants', description: 'Per-user consent grants (user X allowed app Y to call API Z with scope W). Tenant-wide consents are skipped.' },
];

// ─── Azure DevOps constants & helpers ────────────────────────────────────────

const ADO_OBJECT_TYPES = [
  { key: 'users',    label: 'Users & Access Levels',  description: 'All organization members with their access level (Basic, Stakeholder, Visual Studio)' },
  { key: 'projects', label: 'Projects',               description: 'All Azure DevOps projects in the organization' },
  { key: 'teams',    label: 'Teams & Members',        description: 'Project teams and their memberships' },
  { key: 'groups',   label: 'Security Groups',        description: 'Organization and project-level security groups and their memberships' },
  { key: 'repos',    label: 'Repositories & ACLs',   description: 'Git repositories per project and their security ACLs (explicit allow/deny per identity)' },
];

// Normalise an ADO organization URL to { orgName, orgUrl }.
// Accepts: https://dev.azure.com/myorg, https://myorg.visualstudio.com, or just "myorg".
function parseAdoOrgUrl(raw) {
  const s = (raw || '').trim().replace(/\/$/, '');
  const devAzure = s.match(/dev\.azure\.com\/([^/?#]+)/);
  if (devAzure) return { orgName: devAzure[1], orgUrl: `https://dev.azure.com/${devAzure[1]}` };
  const visualStudio = s.match(/^https?:\/\/([^.]+)\.visualstudio\.com/i);
  if (visualStudio) return { orgName: visualStudio[1], orgUrl: `https://dev.azure.com/${visualStudio[1]}` };
  // Bare org name (no slashes/dots → treat as org name)
  if (s && !s.includes('/') && !s.includes('.')) return { orgName: s, orgUrl: `https://dev.azure.com/${s}` };
  return { orgName: null, orgUrl: s };
}

// Build a Basic Authorization header from a PAT.
function buildAdoAuthHeader(_authMode, creds) {
  const encoded = Buffer.from(`:${creds.personalAccessToken}`).toString('base64');
  return `Basic ${encoded}`;
}

// Store a PAT in the vault. Returns the stable secretRef key used for retrieval.
async function storeAdoSecret(_authMode, creds, existingRef) {
  const rawSecret = creds.personalAccessToken;
  if (!rawSecret || rawSecret === SECRET_MASK) return existingRef || null;
  const secretRef = existingRef || `ado-crawler-${randomUUID()}`;
  await putSecret(secretRef, 'ado-crawler', rawSecret, 'Personal Access Token');
  return secretRef;
}

function maskConfig(config) {
  if (!config) return null;
  const parsed = typeof config === 'string' ? JSON.parse(config) : config;
  const masked = { ...parsed };
  // Entra ID
  if (masked.clientSecret) masked.clientSecret = SECRET_MASK;
  // Azure DevOps — mask the vault key reference, strip any ephemeral resolved secret
  if (masked.credentials?.secretRef) {
    masked.credentials = { ...masked.credentials, secretRef: SECRET_MASK };
  }
  if (masked._resolvedSecret !== undefined) delete masked._resolvedSecret;
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
    let configToStore = config || {};

    // ADO: store the PAT in the vault before writing the config row.
    if (crawlerType === 'azure-devops') {
      const creds = configToStore.credentials || {};
      const secretRef = await storeAdoSecret(null, creds, null);
      if (secretRef) {
        configToStore = {
          ...configToStore,
          credentials: {
            ...creds,
            personalAccessToken: undefined,
            secretRef,
          },
        };
      }
    }

    const result = await pool.request()
      .input('crawlerType', crawlerType)
      .input('displayName', displayName.trim().slice(0, 255))
      .input('config', JSON.stringify(configToStore))
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

  const { displayName, config, nextRunMode } = req.body;
  if (nextRunMode !== undefined && nextRunMode !== 'full' && nextRunMode !== 'delta') {
    return res.status(400).json({ error: 'nextRunMode must be "full" or "delta"' });
  }

  try {
    const pool = await db.getPool();

    // Read existing config to preserve secret if not provided
    const existing = await pool.request().input('id', id)
      .query(`SELECT config FROM "CrawlerConfigs" WHERE id = @id`);
    if (existing.recordset.length === 0) return res.status(404).json({ error: 'Config not found' });

    let mergedConfig = (typeof existing.recordset[0].config === "string" ? JSON.parse(existing.recordset[0].config) : existing.recordset[0].config);
    if (config) {
      const incoming = { ...config };
      // Entra ID: If secret is the mask or empty, keep existing
      if (!incoming.clientSecret || incoming.clientSecret === SECRET_MASK) {
        incoming.clientSecret = mergedConfig.clientSecret;
      }
      // ADO: update vault entry if a new PAT is provided; otherwise keep the existing secretRef
      const existingCrawlerType = existing.recordset[0].crawlerType || mergedConfig._crawlerType;
      if (existingCrawlerType === 'azure-devops' || mergedConfig.credentials?.secretRef) {
        const incomingCreds = incoming.credentials || {};
        const existingRef = mergedConfig.credentials?.secretRef;
        const secretRef = await storeAdoSecret(null, incomingCreds, existingRef);
        incoming.credentials = {
          ...incomingCreds,
          personalAccessToken: undefined,
          secretRef: secretRef || existingRef,
        };
      }
      mergedConfig = { ...mergedConfig, ...incoming };
    }

    const sets = ['config = @config', '"updatedAt" = now()'];
    const request = pool.request().input('id', id).input('config', JSON.stringify(mergedConfig));

    if (displayName !== undefined) {
      sets.push('"displayName" = @displayName');
      request.input('displayName', displayName.trim().slice(0, 255));
    }

    if (nextRunMode !== undefined) {
      sets.push('"nextRunMode" = @nextRunMode');
      request.input('nextRunMode', nextRunMode);
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

    // Read before delete to clean up ADO vault secret
    const existing = await pool.request().input('id', id)
      .query(`SELECT "crawlerType", config FROM "CrawlerConfigs" WHERE id = @id`);
    if (existing.recordset.length === 0) return res.status(404).json({ error: 'Config not found' });
    const existingRow = existing.recordset[0];
    const existingCfg = typeof existingRow.config === 'string' ? JSON.parse(existingRow.config) : existingRow.config;

    const result = await pool.request().input('id', id)
      .query(`DELETE FROM "CrawlerConfigs" WHERE id = @id`);
    if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Config not found' });

    // Best-effort cleanup: ADO vault secret + CSV upload folder
    if (existingRow.crawlerType === 'azure-devops' && existingCfg?.credentials?.secretRef) {
      deleteSecret(existingCfg.credentials.secretRef).catch(() => {});
    }
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
// AZURE DEVOPS CREDENTIAL VALIDATION
// ═══════════════════════════════════════════════════════════════════

// POST /api/admin/validate-ado-credentials
// Tests connectivity to an ADO organization and checks which data scopes are accessible.
router.post('/admin/validate-ado-credentials', async (req, res) => {
  const { organizationUrl, personalAccessToken } = req.body;
  if (!organizationUrl) return res.status(400).json({ error: 'organizationUrl is required' });
  if (!personalAccessToken) return res.status(400).json({ error: 'personalAccessToken is required' });

  const { orgName, orgUrl } = parseAdoOrgUrl(organizationUrl);
  if (!orgName) return res.status(400).json({ error: 'Could not parse organization name from URL. Use https://dev.azure.com/myorg or just myorg.' });

  try {
    const authHeader = buildAdoAuthHeader('pat', { personalAccessToken });

    // Connectivity check — projects endpoint is universally accessible if credentials are valid
    const projectsRes = await fetch(`${orgUrl}/_apis/projects?api-version=7.1&$top=1`, {
      headers: { Authorization: authHeader },
    });
    if (!projectsRes.ok) {
      const err = await projectsRes.json().catch(() => ({}));
      const msg = err.message || err.typeKey || `HTTP ${projectsRes.status}`;
      return res.json({ valid: false, error: `Cannot reach Azure DevOps organization '${orgName}': ${msg}` });
    }

    // Get organization display name from connection data
    let organizationName = orgName;
    try {
      const connRes = await fetch(`${orgUrl}/_apis/connectiondata?api-version=7.1`, {
        headers: { Authorization: authHeader },
      });
      if (connRes.ok) {
        const conn = await connRes.json();
        organizationName = conn.authenticatedUser?.customDisplayName
          || conn.locationServiceData?.organizationName
          || orgName;
      }
    } catch { /* non-critical */ }

    // Test data scopes in parallel.
    const usersProbeUrl = `https://vsaex.dev.azure.com/${orgName}/_apis/memberentitlements?api-version=7.1-preview.2&$top=1`;

    const probeResult = async (url, headers) => {
      try {
        const r = await fetch(url, { headers });
        if (r.ok) return { ok: true };
        const body = await r.json().catch(() => ({}));
        const msg = body.message || body.typeKey || `HTTP ${r.status}`;
        console.warn(`ADO scope probe failed [${r.status}] ${url}: ${msg}`);
        return { ok: false, error: msg };
      } catch (err) {
        console.warn(`ADO scope probe error ${url}: ${err.message}`);
        return { ok: false, error: err.message };
      }
    };

    const [usersRes, groupsRes, reposRes] = await Promise.all([
      probeResult(usersProbeUrl, { Authorization: authHeader }),
      probeResult(`https://vssps.dev.azure.com/${orgName}/_apis/graph/groups?api-version=7.1-preview.1&$top=1`, { Authorization: authHeader }),
      // Test repo access by listing repos in the first project (if any)
      fetch(`${orgUrl}/_apis/projects?api-version=7.1&$top=1`, {
        headers: { Authorization: authHeader },
      }).then(async r => {
        if (!r.ok) return { ok: false };
        const d = await r.json().catch(() => ({}));
        const firstProject = d.value?.[0]?.id;
        if (!firstProject) return { ok: true }; // no projects, assume access is fine
        return probeResult(`${orgUrl}/${firstProject}/_apis/git/repositories?api-version=7.1`, { Authorization: authHeader });
      }).catch(err => ({ ok: false, error: err.message })),
    ]);

    res.json({
      valid: true,
      organization: orgName,
      organizationName,
      testedScopes: {
        projects:   true,
        teams:      true,
        users:      usersRes.ok,
        usersError: usersRes.error,
        groups:     groupsRes.ok,
        groupsError: groupsRes.error,
        repos:      reposRes.ok,
        reposError: reposRes.error,
      },
      objectTypes: ADO_OBJECT_TYPES,
    });
  } catch (err) {
    console.error('Error validating ADO credentials:', err.message);
    res.json({ valid: false, error: err.message });
  }
});

// POST /api/admin/discover-ado-projects
// Returns the list of projects accessible with the given credentials.
// Used by the wizard Step 3 "Selected projects" filter.
router.post('/admin/discover-ado-projects', async (req, res) => {
  const { organizationUrl, personalAccessToken, configId } = req.body;

  let resolvedPat = personalAccessToken;

  // Resolve PAT from stored config when editing without re-entering credentials
  if (configId && useSql) {
    try {
      const pool = await db.getPool();
      const cfgRes = await pool.request().input('id', configId)
        .query(`SELECT config FROM "CrawlerConfigs" WHERE id = @id`);
      if (cfgRes.recordset.length === 0) return res.status(404).json({ error: 'Config not found' });
      const cfg = typeof cfgRes.recordset[0].config === 'string' ? JSON.parse(cfgRes.recordset[0].config) : cfgRes.recordset[0].config;
      if (cfg.credentials?.secretRef) {
        const secret = await getSecret(cfg.credentials.secretRef);
        if (secret) resolvedPat = secret;
      }
    } catch (err) {
      return res.status(500).json({ error: 'Failed to load config' });
    }
  }

  const { orgName, orgUrl } = parseAdoOrgUrl(organizationUrl);
  if (!orgName) return res.status(400).json({ error: 'organizationUrl is required' });

  try {
    const authHeader = buildAdoAuthHeader('pat', { personalAccessToken: resolvedPat });
    const projectsRes = await fetch(`${orgUrl}/_apis/projects?api-version=7.1&$top=300&$skip=0`, {
      headers: { Authorization: authHeader },
    });
    if (!projectsRes.ok) return res.status(400).json({ error: `ADO projects API returned ${projectsRes.status}` });
    const data = await projectsRes.json();
    const projects = (data.value || []).map(p => ({
      id:          p.id,
      name:        p.name,
      description: p.description,
      visibility:  p.visibility,
    }));
    res.json({ projects });
  } catch (err) {
    console.error('Error discovering ADO projects:', err.message);
    res.status(500).json({ error: err.message });
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

  const { jobType, config, configId, syncMode: explicitSyncMode } = req.body;
  if (!jobType || !VALID_JOB_TYPES.includes(jobType)) {
    return res.status(400).json({ error: `jobType must be one of: ${VALID_JOB_TYPES.join(', ')}` });
  }
  if (explicitSyncMode !== undefined && explicitSyncMode !== 'full' && explicitSyncMode !== 'delta') {
    return res.status(400).json({ error: 'syncMode must be "full" or "delta"' });
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
    let configNextRunMode = null;
    if (configId) {
      const cfgResult = await pool.request().input('configId', configId)
        .query(`SELECT config, "nextRunMode" FROM "CrawlerConfigs" WHERE id = @configId AND "enabled" = TRUE`);
      if (cfgResult.recordset.length === 0) {
        return res.status(404).json({ error: 'Crawler config not found' });
      }
      // jsonb is auto-parsed by pg; legacy string column may still appear in tests.
      const raw = cfgResult.recordset[0].config;
      resolvedConfig = (typeof raw === 'string') ? JSON.parse(raw) : raw;
      configNextRunMode = cfgResult.recordset[0].nextRunMode || 'delta';
    }

    // Validate entra-id has credentials
    if (jobType === 'entra-id') {
      if (!resolvedConfig?.tenantId || !resolvedConfig?.clientId || !resolvedConfig?.clientSecret) {
        return res.status(400).json({ error: 'Entra ID jobs require tenantId, clientId, and clientSecret' });
      }
    }

    // ADO: resolve the vault secret and embed it ephemerally in the job config
    if (jobType === 'azure-devops') {
      const secretRef = resolvedConfig?.credentials?.secretRef;
      if (!secretRef) {
        return res.status(400).json({ error: 'Azure DevOps config is missing credential reference — please re-configure the crawler' });
      }
      const resolvedSecret = await getSecret(secretRef);
      if (!resolvedSecret) {
        return res.status(400).json({ error: 'Azure DevOps credentials not found in vault — please re-configure the crawler' });
      }
      resolvedConfig = { ...resolvedConfig, _resolvedSecret: resolvedSecret };
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
    // Explicit syncMode in the request body wins (the "Run Delta" / "Run
    // Full" buttons). Falls back to the stored config's nextRunMode toggle,
    // then delta. Inline configs without a configId still accept an explicit
    // syncMode so API clients can control it.
    const effectiveSyncMode = explicitSyncMode || configNextRunMode || 'delta';
    const configToStore = configId
      ? { ...(resolvedConfig || {}), _scheduledByConfigId: configId, _syncMode: effectiveSyncMode }
      : (resolvedConfig ? { ...resolvedConfig, _syncMode: effectiveSyncMode } : null);
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

// GET /api/admin/crawler-jobs/:id/log — tail the per-job trace log.
//
// The worker's Invoke-CrawlerJob.ps1 wraps each run in Start-Transcript,
// writing every Write-Host line (plus child script output) to
// /data/uploads/jobs/{id}.log. That volume is also mounted into the web
// container, so we can read it here.
//
// Query params:
//   offset — byte position to read from (client passes back the totalLength
//            it received last time for efficient incremental polling)
// Response:
//   { text: <string>, offset: <int>, totalLength: <int>, truncated: <bool>,
//     exists: <bool> }
//
// `truncated=true` means the response was capped at MAX_TRACE_CHUNK bytes
// — the client should poll again with the new offset (offset + text.length).
router.get('/admin/crawler-jobs/:id/log', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id < 0) return res.status(400).json({ error: 'Invalid job ID' });
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  const logPath = path.join(TRACE_DIR, `${id}.log`);
  try {
    const stat = await fs.stat(logPath);
    const totalLength = stat.size;
    if (offset >= totalLength) {
      return res.json({ text: '', offset, totalLength, truncated: false, exists: true });
    }
    const length = Math.min(MAX_TRACE_CHUNK, totalLength - offset);
    const fh = await fs.open(logPath, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);
      const text = buf.toString('utf8');
      const truncated = (offset + length) < totalLength;
      return res.json({ text, offset, totalLength, truncated, exists: true });
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.json({ text: '', offset: 0, totalLength: 0, truncated: false, exists: false });
    }
    console.error(`Error reading trace log for job ${id}:`, err.message);
    res.status(500).json({ error: 'Failed to read trace log' });
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
