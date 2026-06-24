// Live discovery handler for the Azure RM crawler wizard.
// Authenticates with the configured service principal and returns the
// subscriptions it can see plus the nested management-group tree, so the
// wizard can render checkable lists instead of free-text fields.
//
// Loaded dynamically by the generic POST /admin/crawlers/:type/discover
// endpoint in routes/jobs.js. Dependencies are injected via the third
// argument so this file has no hard-coded paths into the API source tree.
//
// handler(req, res, { db, getConfigSecret })

const ARM = 'https://management.azure.com';

function timedFetch(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(20_000) });
}

// Client-credentials token for the ARM audience.
async function getArmToken(tenantId, clientId, clientSecret) {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const res = await timedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: `${ARM}/.default`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Token request failed (HTTP ${res.status})`);
    err.detail = body.slice(0, 300);
    throw err;
  }
  const j = await res.json();
  return j.access_token;
}

async function armGet(path, token) {
  const res = await timedFetch(`${ARM}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = new Error(`ARM GET ${path} → HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Flatten a recursive management-group tree into a depth-annotated list,
// keeping only managementGroup nodes (the expand also returns subscriptions).
function flattenManagementGroups(node, depth, out) {
  const children = node?.properties?.children ?? node?.children ?? [];
  for (const ch of children) {
    const type = (ch.type || '').toLowerCase();
    if (type.endsWith('/managementgroups')) {
      out.push({
        name: ch.name,
        displayName: ch.properties?.displayName ?? ch.displayName ?? ch.name,
        depth,
      });
      flattenManagementGroups(ch, depth + 1, out);
    }
  }
  return out;
}

export default async function handler(req, res, { db, getConfigSecret }) {
  const { configId, config: inlineConfig } = req.body;

  // Resolve the config (inline creds from the wizard, or a saved config + its
  // vaulted secret on edit). Configs created directly may keep the secret in
  // the config JSON, so prefer that and fall back to the vault.
  let c;
  try {
    if (configId != null) {
      const id = parseInt(configId, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'configId must be a number' });
      const row = await db.queryOne('SELECT config FROM "CrawlerConfigs" WHERE id = $1', [id]);
      if (!row) return res.status(404).json({ error: 'Config not found' });
      c = typeof row.config === 'string' ? JSON.parse(row.config) : { ...row.config };
      if (!c.clientSecret && getConfigSecret) {
        c.clientSecret = await getConfigSecret(id).catch(() => null);
      }
    } else if (inlineConfig && typeof inlineConfig === 'object') {
      c = inlineConfig;
    } else {
      return res.status(400).json({ error: 'configId or config required' });
    }
  } catch (err) {
    console.error('azure-rm/discover config lookup error:', err.message);
    return res.status(500).json({ error: 'Failed to load config' });
  }

  const tenantId = (c.tenantId || '').trim();
  const clientId = (c.clientId || '').trim();
  const clientSecret = (c.clientSecret || '').trim();
  if (!tenantId || !clientId || !clientSecret) {
    return res.status(400).json({ error: 'tenantId, clientId and clientSecret are required to discover subscriptions' });
  }

  let token;
  try {
    token = await getArmToken(tenantId, clientId, clientSecret);
  } catch (err) {
    return res.status(502).json({ error: `Could not authenticate to Azure: ${err.message}` });
  }

  // Subscriptions and management groups are independent — surface whatever we
  // can reach. A service principal scoped to a single subscription often can't
  // read management groups (403), and that's fine.
  const out = { subscriptions: [], managementGroups: [] };

  try {
    const subs = await armGet('/subscriptions?api-version=2020-01-01', token);
    out.subscriptions = (subs.value || []).map((s) => ({
      id: s.subscriptionId,
      name: s.displayName || s.subscriptionId,
    }));
  } catch (err) {
    out.subscriptionsError = err.message;
  }

  try {
    // Expand the tenant-root management group (named after the tenant) to get
    // the full nested tree. Falls back to the flat list if the root isn't
    // readable by this principal.
    let tree = null;
    try {
      tree = await armGet(
        `/providers/Microsoft.Management/managementGroups/${encodeURIComponent(tenantId)}?api-version=2020-05-01&$expand=children&$recurse=true`,
        token,
      );
    } catch { /* fall back to flat list below */ }

    if (tree) {
      out.managementGroups = [
        { name: tree.name, displayName: tree.properties?.displayName ?? tree.name, depth: 0 },
        ...flattenManagementGroups(tree, 1, []),
      ];
    } else {
      const flat = await armGet('/providers/Microsoft.Management/managementGroups?api-version=2020-05-01', token);
      out.managementGroups = (flat.value || []).map((m) => ({
        name: m.name,
        displayName: m.properties?.displayName ?? m.name,
        depth: 0,
      }));
    }
  } catch (err) {
    out.managementGroupsError = err.message;
  }

  res.json(out);
}
