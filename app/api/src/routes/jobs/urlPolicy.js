// Connector-URL policy for crawler configs (SEC-2026-09 M-02 / M-03).
//
// A pull crawler sends its credential to whatever baseUrl / tokenEndpoint its
// config names. Those URLs are run through the shared SSRF guard:
//   - https only, unless the config sets `allowInsecureHttp: true`;
//   - public addresses only, unless the config sets `allowPrivateNetwork: true`
//     (an on-premises Omada / midPoint / SCIM server on a private network);
//   - link-local / cloud-metadata / reserved addresses are refused either way.
// The same two flags are honoured by the worker (tools/crawlers/shared/
// Assert-FGPublicUrl.ps1), which re-checks at connect time and on every
// server-supplied pagination link. Which fields are URLs is declared per crawler
// in crawler.json (`urlFields`), so this file carries no per-type knowledge.

import { assertPublicUrl } from '../../lib/ssrfGuard.js';
import { getUrlFields } from '../../crawlerManifests.js';

// DNS answers that mean "could not resolve right now", not "resolves somewhere bad".
const UNRESOLVED_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ESERVFAIL']);

const HINTS = {
  SSRF_SCHEME: 'enable "Allow insecure HTTP" on this crawler to permit http',
  SSRF_PRIVATE_ADDRESS: 'enable "Allow private network" on this crawler if it is an on-premises system',
};

// The guard options a crawler config asks for. Only a literal `true` opts in.
export function connectorUrlPolicy(config) {
  return {
    allowPrivateNetwork: config?.allowPrivateNetwork === true,
    requireHttps: config?.allowInsecureHttp !== true,
  };
}

// assertPublicUrl under the config's policy, with an operator-facing message that
// names the field and, where one applies, the setting that would permit it. The
// original error code is kept on the thrown error.
export async function assertConnectorUrl(rawUrl, config, label = 'URL') {
  try {
    return await assertPublicUrl(rawUrl, connectorUrlPolicy(config));
  } catch (err) {
    const hint = HINTS[err.code];
    throw Object.assign(new Error(`${label} rejected: ${err.message}${hint ? ` — ${hint}` : ''}`), { code: err.code });
  }
}

// Check every manifest-declared URL field of a config. Returns an error message
// for the first field that fails, or null. A hostname that does not resolve from
// the API container is let through: the worker may sit on a different network
// (and re-checks before connecting), and an unresolvable name reaches nothing.
export async function checkCrawlerConfigUrls(crawlerType, config) {
  for (const field of getUrlFields(crawlerType)) {
    const value = config?.[field];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    try {
      await assertConnectorUrl(String(value).trim(), config, field);
    } catch (err) {
      if (!UNRESOLVED_CODES.has(err.code)) return err.message;
    }
  }
  return null;
}
