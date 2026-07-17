// Live discovery handler for the midPoint crawler wizard.
// Connects to the midPoint server and returns archetypes / subtypes
// used to populate the wizard's mapping dropdowns.
//
// Loaded dynamically by the generic POST /admin/crawlers/:type/discover
// endpoint in routes/jobs.js. Dependencies are injected via the third
// argument so this file has no hard-coded paths into the API source tree.
//
// handler(req, res, { db, getConfigSecret })
//   db             — app/api/src/db/connection.js pool wrapper
//   getConfigSecret — app/api/src/secrets/crawlerSecrets.js vault reader

// ─── midPoint helpers ────────────────────────────────────────────────────────

// Coerce a midPoint field (PolyString { orig } / { norm }, plain string, or
// array of any of the above) to a single string.
function mpPoly(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) { for (const x of v) { const s = mpPoly(x); if (s) return s; } return ''; }
  if (v.orig) return String(v.orig);
  if (v.norm) return String(v.norm);
  return String(v);
}

function mpPolyList(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map(mpPoly).filter(Boolean);
}

// Normalise any midPoint base URL to the REST root (mirrors Get-MidpointRestRoot).
// String operations only — no regex on admin-supplied input, to avoid ReDoS.
function midpointRestRoot(baseUrl) {
  let b = baseUrl.trim();
  let end = b.length;
  while (end > 0 && b[end - 1] === '/') end--;
  b = b.slice(0, end);
  const lower = b.toLowerCase();
  if (lower.endsWith('/ws/rest')) return b;
  if (lower.endsWith('/midpoint')) return b + '/ws/rest';
  const idx = lower.indexOf('/midpoint/');
  if (idx !== -1) return b.slice(0, idx + '/midpoint'.length) + '/ws/rest';
  return b + '/midpoint/ws/rest';
}

function assertHttpUrl(raw, label) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`${label} must use http or https`);
  }
  return u;
}

// Timed fetch (15 s) — avoids hanging forever on an unreachable midPoint node.
function mpFetch(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(15_000) });
}

// Build the Authorization header, performing the OAuth2 token exchange when needed.
async function midpointAuthHeader(c) {
  const m = c.authMethod;
  if (m === 'BasicAuth') {
    if (!c.username || !c.password) throw new Error('username and password are required for BasicAuth');
    return 'Basic ' + Buffer.from(`${c.username}:${c.password}`).toString('base64');
  }
  if (m === 'ApiToken') {
    if (!c.apiToken) throw new Error('apiToken is required for ApiToken auth');
    return 'Bearer ' + c.apiToken;
  }
  if (m === 'OAuth2CC' || m === 'OAuth2ROPC') {
    if (!c.tokenEndpoint || !c.clientId || !c.clientSecret) {
      throw new Error('tokenEndpoint, clientId and clientSecret are required for OAuth2');
    }
    assertHttpUrl(c.tokenEndpoint, 'tokenEndpoint');
    const form = new URLSearchParams({
      grant_type: m === 'OAuth2CC' ? 'client_credentials' : 'password',
      client_id: c.clientId,
      client_secret: c.clientSecret,
    });
    if (m === 'OAuth2ROPC') { form.set('username', c.username || ''); form.set('password', c.password || ''); }
    const tr = await mpFetch(c.tokenEndpoint, {
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

// POST /{type}/search and unwrap the { object: { object: [...] } } envelope.
async function midpointSearch(restRoot, authHeader, type, maxSize) {
  const res = await mpFetch(`${restRoot}/${type}/search`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: { paging: { maxSize } } }),
  });
  if (!res.ok) throw new Error(`${type}/search returned HTTP ${res.status}`);
  const data = await res.json();
  const inner = data && data.object && data.object.object;
  if (!inner) return [];
  return Array.isArray(inner) ? inner : [inner];
}

// ─── Discovery handler ───────────────────────────────────────────────────────

export default async function handler(req, res, { db, getConfigSecret, assertPublicUrl }) {
  const { configId, config: inlineConfig } = req.body;

  let c;
  try {
    if (configId != null) {
      const id = parseInt(configId, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'configId must be a number' });
      const row = await db.queryOne(`SELECT config FROM "CrawlerConfigs" WHERE id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'Config not found' });
      c = typeof row.config === 'string' ? JSON.parse(row.config) : { ...row.config };
      // clientSecret lives in the vault, not in the stored JSON — fetch it for OAuth2.
      if ((c.authMethod === 'OAuth2CC' || c.authMethod === 'OAuth2ROPC') && !c.clientSecret) {
        c.clientSecret = await getConfigSecret(id);
      }
    } else if (inlineConfig && typeof inlineConfig === 'object') {
      c = inlineConfig;
    } else {
      return res.status(400).json({ error: 'configId or config required' });
    }
  } catch (err) {
    console.error('midpoint/discover config lookup error:', err.message);
    return res.status(500).json({ error: 'Failed to load config' });
  }

  try {
    const rawBaseUrl = (c.baseUrl || '').trim();
    if (!rawBaseUrl) return res.status(400).json({ error: 'No baseUrl in config' });
    assertHttpUrl(rawBaseUrl, 'baseUrl');
    // Reject a base URL that resolves to a private/loopback/metadata address
    // before we fetch it with the connector's credential (SSRF guard, L-6).
    try {
      await assertPublicUrl(rawBaseUrl);
    } catch (e) {
      return res.status(400).json({ error: `baseUrl rejected: ${e.message}` });
    }
    const restRoot = midpointRestRoot(rawBaseUrl);

    let authHeader;
    try {
      authHeader = await midpointAuthHeader(c);
    } catch (authErr) {
      return res.status(400).json({ error: authErr.message });
    }

    // Archetypes first — also validates connectivity + credentials.
    let archetypeObjs;
    try {
      archetypeObjs = await midpointSearch(restRoot, authHeader, 'archetypes', 500);
    } catch (connErr) {
      return res.status(502).json({ error: `Could not reach midPoint: ${connErr.message}` });
    }

    // Keep only archetypes applicable to RoleType — drops task/report/case system
    // archetypes that are noise for role classification. Falls back to all archetypes
    // if the filter would empty the list (unexpected archetype shape).
    const mpLocalName = (qn) => String(qn || '').replace(/^.*[#:]/, '');
    const mpRefOid = (ref) => { const r = Array.isArray(ref) ? ref[0] : ref; return r ? String(r.oid || '') : ''; };
    const holderByOid = new Map();
    const superByOid = new Map();
    for (const a of archetypeObjs) {
      const oid = String(a.oid || '');
      if (!oid) continue;
      const holders = new Set();
      for (const src of [a.assignment, a.inducement]) {
        for (const it of (Array.isArray(src) ? src : (src ? [src] : []))) {
          const rels = it && it.assignmentRelation;
          for (const rel of (Array.isArray(rels) ? rels : (rels ? [rels] : []))) {
            const ht = rel && rel.holderType;
            for (const h of (Array.isArray(ht) ? ht : (ht ? [ht] : []))) holders.add(mpLocalName(h));
          }
        }
      }
      holderByOid.set(oid, holders);
      const sup = mpRefOid(a.superArchetypeRef);
      if (sup) superByOid.set(oid, sup);
    }
    const isRoleArchetype = (oid, seen = new Set()) => {
      if (!oid || seen.has(oid)) return false;
      seen.add(oid);
      if ((holderByOid.get(oid) || new Set()).has('RoleType')) return true;
      const sup = superByOid.get(oid);
      return sup ? isRoleArchetype(sup, seen) : false;
    };
    const roleArchetypeObjs = archetypeObjs.filter(a => isRoleArchetype(String(a.oid || '')));
    const archetypes = (roleArchetypeObjs.length ? roleArchetypeObjs : archetypeObjs)
      .map(a => ({ oid: String(a.oid || ''), name: mpPoly(a.name) || mpPoly(a.displayName) || mpPoly(a.identifier), identifier: mpPoly(a.identifier) }))
      .filter(a => a.oid && a.name);

    // Subtypes are best-effort — a missing type yields an empty list.
    const safeSearch = async (t) => { try { return await midpointSearch(restRoot, authHeader, t, 1000); } catch { return []; } };
    const [roles, orgs, users] = await Promise.all([safeSearch('roles'), safeSearch('orgs'), safeSearch('users')]);

    const uniqSorted = (arr) => [...new Set(arr.filter(Boolean))].sort((x, y) => x.localeCompare(y));
    const roleSubtypes = uniqSorted([...roles.flatMap(r => mpPolyList(r.subtype)), ...roles.flatMap(r => mpPolyList(r.roleType))]);
    const orgSubtypes = uniqSorted(orgs.flatMap(o => mpPolyList(o.subtype)));
    const userTypes = uniqSorted([...users.flatMap(u => mpPolyList(u.subtype)), ...users.flatMap(u => mpPolyList(u.employeeType))]);

    res.json({ archetypes, roleSubtypes, orgSubtypes, userTypes });
  } catch (err) {
    console.error('midpoint/discover error:', err.message);
    res.status(500).json({ error: 'Failed to discover midPoint metadata' });
  }
}
