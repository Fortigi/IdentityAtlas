// OAuthSentry malicious-app threat feed ingest.
//
// OAuthSentry (https://oauthsentry.github.io, MIT-licensed) publishes a public
// CSV of OAuth apps seen in BEC / AiTM / consent-phishing campaigns — no API key,
// no auth. We fetch it at run time and match consented apps' appIds against it; we
// never redistribute the dataset (so the data/ upstream-license carve-out doesn't
// apply — we only read appIds). Attribution: OAuthSentry.
//
// Feed columns: appname,appid,metadata_category,metadata_severity,metadata_comment,
//               metadata_reference,service   (appId is a GUID in `appid`).

export const DEFAULT_FEED_URL = 'https://oauthsentry.github.io/feeds/all/all_malicious.csv';

// Minimal quote-aware CSV line split (fields may contain commas inside quotes).
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else { cur += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse the OAuthSentry CSV into a Set of lower-cased appIds. Tolerant: locates the
 * `appid` column from the header, skips blank lines, ignores rows without an id.
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseAppIdsCsv(text) {
  const ids = new Set();
  if (!text || typeof text !== 'string') return ids;
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) return ids;
  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const idx = header.indexOf('appid');
  if (idx === -1) return ids;
  for (let i = 1; i < lines.length; i++) {
    const id = (splitCsvLine(lines[i])[idx] || '').trim().toLowerCase();
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Fetch the malicious-app feed and return a Set of lower-cased appIds.
 * `fetchImpl` is injectable for unit tests.
 * @param {string} [feedUrl]
 * @param {Function} [fetchImpl]
 * @returns {Promise<Set<string>>}
 */
export async function fetchMaliciousAppIds(feedUrl = DEFAULT_FEED_URL, fetchImpl = fetch) {
  const r = await fetchImpl(feedUrl, { headers: { 'User-Agent': 'IdentityAtlas-risky-app-consent' } });
  if (!r.ok) throw new Error(`OAuthSentry feed fetch returned ${r.status}`);
  return parseAppIdsCsv(await r.text());
}
