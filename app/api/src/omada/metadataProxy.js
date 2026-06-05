// Proxy fetch for the Omada OData $metadata endpoint.
//
// Intentionally excluded from the CodeQL js/request-forgery query
// (see .github/codeql/codeql-config.yml). The URL is admin-supplied,
// scheme-validated to http/https, and the calling endpoint is
// protected by admin auth middleware.

export async function fetchOmadaMetadata(metaUrl, headers) {
  const opts = { signal: AbortSignal.timeout(10_000) };
  if (headers && Object.keys(headers).length) opts.headers = headers;
  return fetch(metaUrl, opts);
}
