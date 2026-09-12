// Shared REST plumbing for crawler `discover.js` handlers.
//
// Every REST crawler's discover.js had its own copy of the same three things:
// a URL-scheme guard, a timed fetch, and an Authorization-header builder that
// handles BasicAuth / ApiToken / OAuth2 client-credentials. They are identical
// apart from the crawler's name in a comment, so jscpd counted them as clones.
//
// Lives under tools/crawlers/shared/ (not app/api/src/) because it is crawler
// plumbing, and the API image copies this whole tree to /app/crawlers — so the
// relative import from a sibling crawler folder resolves in Docker as it does
// in a dev checkout. See app/api/Dockerfile.

// Reject anything that isn't http(s) before it reaches fetch — a config could
// otherwise point discovery at file: or another scheme.
export function assertHttpUrl(raw, label) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`${label} must use http or https`);
  }
  return u;
}

// Timed fetch — avoids hanging forever on an unreachable endpoint.
export function timedFetch(url, opts = {}, timeoutMs = 15_000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}

// Trim trailing slashes off a base URL without a regex (so a pathological
// config string can't drive catastrophic backtracking).
export function trimTrailingSlashes(raw) {
  const b = String(raw || '').trim();
  let end = b.length;
  while (end > 0 && b[end - 1] === '/') end--;
  return b.slice(0, end);
}

// Build the Authorization header for a discover call, performing the OAuth2
// token exchange when the config asks for it.
//
// Two OAuth2 grants are supported because the crawlers between them use both:
// OAuth2CC is client_credentials, OAuth2ROPC is the password grant and also
// sends the user's own username/password in the form. `oauthMethods` says which
// of them this crawler offers, so a crawler that only supports one still
// rejects the other as unsupported rather than silently accepting it.
const OAUTH_GRANTS = { OAuth2CC: 'client_credentials', OAuth2ROPC: 'password' };

export async function buildAuthHeader(c, { oauthMethods = ['OAuth2CC'] } = {}) {
  const m = c.authMethod;
  if (m === 'BasicAuth') {
    if (!c.username || !c.password) throw new Error('username and password are required for BasicAuth');
    return 'Basic ' + Buffer.from(`${c.username}:${c.password}`).toString('base64');
  }
  if (m === 'ApiToken') {
    if (!c.apiToken) throw new Error('apiToken is required for ApiToken auth');
    return 'Bearer ' + c.apiToken;
  }
  if (oauthMethods.includes(m) && OAUTH_GRANTS[m]) {
    if (!c.tokenEndpoint || !c.clientId || !c.clientSecret) {
      throw new Error('tokenEndpoint, clientId and clientSecret are required for OAuth2');
    }
    assertHttpUrl(c.tokenEndpoint, 'tokenEndpoint');
    const form = new URLSearchParams({
      grant_type: OAUTH_GRANTS[m],
      client_id: c.clientId,
      client_secret: c.clientSecret,
    });
    if (m === 'OAuth2ROPC') {
      form.set('username', c.username || '');
      form.set('password', c.password || '');
    }
    if (c.scope) form.set('scope', c.scope);
    const tr = await timedFetch(c.tokenEndpoint, {
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
