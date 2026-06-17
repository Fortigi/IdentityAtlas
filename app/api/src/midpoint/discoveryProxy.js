// Proxy fetch for the midPoint REST API (OAuth2 token endpoint + object search),
// used by the admin crawler wizard to live-discover archetypes / subtypes.
//
// Intentionally excluded from the CodeQL js/request-forgery query
// (see .github/codeql/codeql-config.yml). The URL is admin-supplied
// (midPoint can be on-prem or SaaS), scheme-validated to http/https
// before reaching this file, and the calling endpoint is protected by
// admin auth middleware.

export async function midpointFetch(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(15_000) });
}
