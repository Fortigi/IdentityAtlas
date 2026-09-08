// Live discovery handler for the SCIM 2.0 crawler wizard.
//
// Asks the service provider what it actually serves — /ServiceProviderConfig,
// /ResourceTypes and /Schemas — and returns the resource types (so the wizard can
// show which ones are syncable today) plus the per-object attribute lists that
// back the opt-in attribute picker. Also doubles as the wizard's "test these
// credentials" step: a 4xx here is surfaced verbatim to the operator.
//
// Loaded dynamically by the generic POST /admin/crawlers/:type/discover endpoint
// in routes/jobs.js. Dependencies are injected via the third argument so this file
// has no hard-coded paths into the API source tree.
//
// handler(req, res, { db, getConfigSecret, assertPublicUrl })

// Resource types this crawler can sync today. Anything else the endpoint serves is
// returned as `syncable: false` so the wizard can show it as visible-but-not-yet.
const SYNCABLE_RESOURCE_TYPES = ['User', 'Group'];

// Core attributes that are always synced and therefore must not appear in the
// opt-in picker — offering them would imply they were optional.
const CORE_USER_ATTRIBUTES = ['id', 'userName', 'displayName', 'active', 'emails', 'externalId', 'userType', 'name', 'title', 'members', 'groups', 'meta'];
const CORE_GROUP_ATTRIBUTES = ['id', 'displayName', 'externalId', 'members', 'meta'];

function scimBaseUrl(raw) {
  let b = String(raw || '').trim();
  let end = b.length;
  while (end > 0 && b[end - 1] === '/') end--;
  return b.slice(0, end);
}

function assertHttpUrl(raw, label) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`${label} must use http or https`);
  }
  return u;
}

// Timed fetch (15 s) — avoids hanging forever on an unreachable endpoint.
function scimFetch(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(15_000) });
}

async function scimAuthHeader(c) {
  const m = c.authMethod;
  if (m === 'BasicAuth') {
    if (!c.username || !c.password) throw new Error('username and password are required for BasicAuth');
    return 'Basic ' + Buffer.from(`${c.username}:${c.password}`).toString('base64');
  }
  if (m === 'ApiToken') {
    if (!c.apiToken) throw new Error('apiToken is required for ApiToken auth');
    return 'Bearer ' + c.apiToken;
  }
  if (m === 'OAuth2CC') {
    if (!c.tokenEndpoint || !c.clientId || !c.clientSecret) {
      throw new Error('tokenEndpoint, clientId and clientSecret are required for OAuth2');
    }
    assertHttpUrl(c.tokenEndpoint, 'tokenEndpoint');
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: c.clientId,
      client_secret: c.clientSecret,
    });
    if (c.scope) form.set('scope', c.scope);
    const tr = await scimFetch(c.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!tr.ok) throw new Error(`OAuth2 token endpoint returned HTTP ${tr.status}`);
    const tk = await tr.json();
    if (!tk.access_token) throw new Error('OAuth2 token response missing access_token');
    return 'Bearer ' + tk.access_token;
  }
  throw new Error(`Unsupported authMethod: ${m}`);
}

// GET a SCIM endpoint and unwrap the ListResponse `Resources` array. A provider
// that returns a bare array (some do) is tolerated.
async function scimGet(baseUrl, authHeader, path) {
  const res = await scimFetch(`${baseUrl}${path}`, {
    headers: { Authorization: authHeader, Accept: 'application/scim+json' },
  });
  if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
  return res.json();
}

function listOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.Resources)) return payload.Resources;
  return [];
}

// Flatten one SCIM schema's attribute list into pickable names. Complex attributes
// contribute their simple sub-attributes as 'parent.child' so e.g. name.givenName
// is selectable; multi-valued attributes are skipped — v1 stores simple values only.
export function schemaAttributeNames(schema, coreNames) {
  const core = new Set(coreNames);
  const out = [];
  for (const attr of (schema && Array.isArray(schema.attributes) ? schema.attributes : [])) {
    const name = String(attr?.name || '');
    if (!name || core.has(name)) continue;
    if (attr.multiValued) continue;
    if (attr.type === 'complex') {
      for (const sub of (Array.isArray(attr.subAttributes) ? attr.subAttributes : [])) {
        const subName = String(sub?.name || '');
        if (subName && sub.type !== 'complex' && !sub.multiValued) out.push(`${name}.${subName}`);
      }
      continue;
    }
    out.push(name);
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

// Match the schemas a resource type declares (its base schema plus any extensions)
// and merge their pickable attributes into one list.
export function attributesForResourceType(resourceType, schemas, coreNames) {
  const wanted = new Set();
  if (resourceType?.schema) wanted.add(String(resourceType.schema));
  for (const ext of (Array.isArray(resourceType?.schemaExtensions) ? resourceType.schemaExtensions : [])) {
    if (ext?.schema) wanted.add(String(ext.schema));
  }
  const names = [];
  for (const s of schemas) {
    if (wanted.size && !wanted.has(String(s?.id || ''))) continue;
    names.push(...schemaAttributeNames(s, coreNames));
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

// Fall back to matching by schema NAME when the endpoint's resource types don't
// name a schema we recognise (some providers omit /ResourceTypes entirely).
function schemasNamed(schemas, name) {
  return schemas.filter(s => String(s?.name || '').toLowerCase() === name.toLowerCase()
    || String(s?.id || '').toLowerCase().endsWith(`:${name.toLowerCase()}`));
}

async function loadConfig(req, res, { db, getConfigSecret }) {
  const { configId, config: inlineConfig } = req.body;
  if (configId != null) {
    const id = parseInt(configId, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'configId must be a number' }); return null; }
    const row = await db.queryOne(`SELECT config FROM "CrawlerConfigs" WHERE id = $1`, [id]);
    if (!row) { res.status(404).json({ error: 'Config not found' }); return null; }
    const c = typeof row.config === 'string' ? JSON.parse(row.config) : { ...row.config };
    // clientSecret lives in the vault, not the stored JSON — fetch it for OAuth2.
    if (c.authMethod === 'OAuth2CC' && !c.clientSecret) c.clientSecret = await getConfigSecret(id);
    return c;
  }
  if (inlineConfig && typeof inlineConfig === 'object') return inlineConfig;
  res.status(400).json({ error: 'configId or config required' });
  return null;
}

export default async function handler(req, res, { db, getConfigSecret, assertPublicUrl }) {
  let c;
  try {
    c = await loadConfig(req, res, { db, getConfigSecret });
    if (!c) return;
  } catch (err) {
    console.error('scim/discover config lookup error:', err.message);
    return res.status(500).json({ error: 'Failed to load config' });
  }

  try {
    const rawBaseUrl = scimBaseUrl(c.baseUrl);
    if (!rawBaseUrl) return res.status(400).json({ error: 'No baseUrl in config' });
    assertHttpUrl(rawBaseUrl, 'baseUrl');
    // Reject a base URL that resolves to a private/loopback/metadata address
    // before we fetch it with the connector's credential (SSRF guard).
    if (assertPublicUrl) {
      try {
        await assertPublicUrl(rawBaseUrl);
      } catch (e) {
        return res.status(400).json({ error: `baseUrl rejected: ${e.message}` });
      }
    }

    let authHeader;
    try {
      authHeader = await scimAuthHeader(c);
    } catch (authErr) {
      return res.status(400).json({ error: authErr.message });
    }

    // /ResourceTypes is the reachability + credential probe: a failure here is
    // what the operator needs to see, so it is reported rather than swallowed.
    let resourceTypePayload;
    try {
      resourceTypePayload = await scimGet(rawBaseUrl, authHeader, '/ResourceTypes');
    } catch (connErr) {
      return res.status(502).json({ error: `Could not reach the SCIM endpoint: ${connErr.message}` });
    }

    const best = async (path) => { try { return await scimGet(rawBaseUrl, authHeader, path); } catch { return null; } };
    const [schemaPayload, providerConfig] = await Promise.all([best('/Schemas'), best('/ServiceProviderConfig')]);

    const schemas = listOf(schemaPayload);
    const resourceTypes = listOf(resourceTypePayload).map(rt => ({
      id: String(rt?.id || rt?.name || ''),
      name: String(rt?.name || rt?.id || ''),
      endpoint: String(rt?.endpoint || ''),
      schema: String(rt?.schema || ''),
      syncable: SYNCABLE_RESOURCE_TYPES.includes(String(rt?.name || rt?.id || '')),
    })).filter(rt => rt.id);

    const userType = listOf(resourceTypePayload).find(rt => String(rt?.name || rt?.id) === 'User');
    const groupType = listOf(resourceTypePayload).find(rt => String(rt?.name || rt?.id) === 'Group');

    // A resource type that names no schema (and no extension) can't be resolved by
    // id, so fall back to matching schemas by NAME — otherwise "no declared schema"
    // would silently mean "every schema", mixing Group attributes into the User
    // picker.
    const attributesFor = (resourceType, name, coreNames) => {
      const declares = resourceType && (resourceType.schema || (Array.isArray(resourceType.schemaExtensions) && resourceType.schemaExtensions.length > 0));
      return declares
        ? attributesForResourceType(resourceType, schemas, coreNames)
        : attributesForResourceType(null, schemasNamed(schemas, name), coreNames);
    };
    const userAttributes = attributesFor(userType, 'User', CORE_USER_ATTRIBUTES);
    const groupAttributes = attributesFor(groupType, 'Group', CORE_GROUP_ATTRIBUTES);

    res.json({
      resourceTypes,
      userAttributes,
      groupAttributes,
      supportsFilter: !!providerConfig?.filter?.supported,
      supportsPatch: !!providerConfig?.patch?.supported,
    });
  } catch (err) {
    console.error('scim/discover error:', err.message);
    res.status(500).json({ error: 'Failed to discover SCIM metadata' });
  }
}
