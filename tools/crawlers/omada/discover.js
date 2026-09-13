// Live discovery handler for the Omada crawler wizard.
// Fetches $metadata from the Omada OData service and returns the available
// EntitySets and Identity entity property names, used by the wizard to
// validate contextObjectTypes entries in real time.
//
// Loaded dynamically by the generic POST /admin/crawlers/:type/discover
// endpoint in routes/jobs.js. Dependencies are injected via the third
// argument so this file has no hard-coded paths into the API source tree.
//
// handler(req, res, { db, assertConnectorUrl })
//   db                 — app/api/src/db/connection.js pool wrapper
//   assertConnectorUrl — app/api/src/routes/jobs/urlPolicy.js SSRF guard

import { timedFetch } from '../shared/discoverAuth.js';

// Timed fetch (10 s) — avoids hanging forever on an unreachable Omada server.
// Shares the discover plumbing's no-redirect fetch, so a 3xx cannot carry the
// request past the address check below (SEC-2026-09 M-02).
function fetchOmadaMetadata(metaUrl, headers) {
  const opts = {};
  if (headers && Object.keys(headers).length) opts.headers = headers;
  return timedFetch(metaUrl, opts, 10_000);
}

export default async function handler(req, res, { db, assertConnectorUrl }) {
  const { configId, config: inlineConfig } = req.body;

  let c;
  try {
    if (configId != null) {
      const id = parseInt(configId, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'configId must be a number' });
      const row = await db.queryOne(`SELECT config FROM "CrawlerConfigs" WHERE id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'Config not found' });
      c = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    } else if (inlineConfig && typeof inlineConfig === 'object') {
      c = inlineConfig;
    } else {
      return res.status(400).json({ error: 'configId or config required' });
    }
  } catch (err) {
    console.error('omada/discover config lookup error:', err.message);
    return res.status(500).json({ error: 'Failed to load config' });
  }

  try {
    const rawBaseUrl = (c.baseUrl || '').trim();
    if (!rawBaseUrl) return res.status(400).json({ error: 'No baseUrl in config' });

    // Normalize to the OData service root the crawler uses. String operations
    // only — no regex on admin-supplied input, to avoid polynomial ReDoS.
    let trimLen = rawBaseUrl.length;
    while (trimLen > 0 && rawBaseUrl[trimLen - 1] === '/') trimLen--;
    const u = new URL(trimLen < rawBaseUrl.length ? rawBaseUrl.slice(0, trimLen) : rawBaseUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
      return res.status(400).json({ error: 'baseUrl must use http or https' });
    // Reject a base URL that resolves to a private/loopback/metadata address (or
    // uses http) before we fetch it with the connector's credential, unless the
    // config opts in (SSRF guard, L-6 / SEC-2026-09 M-03).
    try {
      await assertConnectorUrl(u.origin, c, 'baseUrl');
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (!u.pathname.toLowerCase().endsWith('/odata/dataobjects')) u.pathname = '/odata/dataobjects';
    const baseUrl = u.origin + u.pathname;

    const metaUrl = `${baseUrl}/$metadata`;

    // Build auth headers (best-effort).
    const headers = {};
    if (c.authMethod === 'BasicAuth' && c.username && c.password) {
      const encoded = Buffer.from(`${c.username}:${c.password}`).toString('base64');
      headers.Authorization = `Basic ${encoded}`;
    } else if (c.authMethod === 'ApiToken' && c.apiToken) {
      headers.Authorization = `Bearer ${c.apiToken}`;
    } else if (c.authMethod === 'CookieString' && c.cookieString) {
      headers.Cookie = c.cookieString;
    }

    let metaRes;
    try {
      metaRes = await fetchOmadaMetadata(metaUrl, headers);
    } catch (connErr) {
      // Transport errors can carry internal detail (resolved addresses, TLS and
      // socket internals); log it, return a fixed message (SEC-2026-09 I-05).
      console.error('omada/discover fetch error:', connErr.message);
      return res.status(502).json({ error: 'Could not reach the Omada $metadata endpoint' });
    }
    if (!metaRes.ok) {
      return res.status(502).json({ error: `Omada $metadata returned HTTP ${metaRes.status}` });
    }
    const xml = await metaRes.text();

    // Parse EntitySet names
    const entitySets = [...xml.matchAll(/EntitySet\s+Name="([^"]+)"/g)].map(m => m[1]).sort();

    // Parse Identity entity type property names
    const identityMatch = xml.match(/<EntityType\s+Name="Identity"[^>]*>([\s\S]*?)<\/EntityType>/);
    let identityProperties = [];
    if (identityMatch) {
      identityProperties = [...identityMatch[1].matchAll(/(?:Property|NavigationProperty)\s+Name="([^"]+)"/g)]
        .map(m => m[1]).sort();
    }

    res.json({ entitySets, identityProperties });
  } catch (err) {
    console.error('omada/discover error:', err.message);
    res.status(500).json({ error: 'Failed to fetch Omada metadata' });
  }
}
