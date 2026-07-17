// Identity Atlas v5 — URL scraper for risk profile inputs.
//
// Fetches the body of one or more URLs and returns plain text suitable for
// passing into an LLM context window. Designed for scrape-on-create rather than
// long-term indexing — the scraped text is held in memory only as long as the
// risk-profile generation request that triggered the fetch.
//
// Per-URL credentials are supported via two mechanisms:
//   - Basic auth: { username, password } → Authorization: Basic ...
//   - Bearer:     { bearer }             → Authorization: Bearer ...
//
// The credential strings are passed in by the caller and are NOT persisted by
// this module. Persistence is the responsibility of the route layer (and uses
// the secrets vault). The caller decrypts secrets and passes plaintext here.
//
// SSRF hardening (security finding H-06): this module never lets a scrape reach
// a non-public address. Instead of a hostname regex (bypassable via DNS
// rebinding, decimal/hex IP encodings, IPv4-mapped IPv6, or redirects) we:
//   - reject literal non-public IP hosts up front,
//   - resolve hostnames ourselves and refuse if ANY resolved address is
//     private/loopback/link-local/ULA, then PIN the connection to a validated
//     address (a custom `lookup`), so the IP that's checked is the IP that's
//     connected to — closing the rebinding TOCTOU,
//   - follow redirects manually, re-validating every hop, and
//   - never send the Authorization header across a redirect to another origin.

import net from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isBlockedAddress, pinnedSafeLookup } from '../lib/ssrfGuard.js';

// Re-export the shared SSRF primitives so existing callers/tests can keep
// importing them from here (the guard itself now lives in lib/ssrfGuard.js so
// the crawler discover handlers can reuse it — audit L-6).
export { isBlockedIPv4, isBlockedAddress, pinnedSafeLookup } from '../lib/ssrfGuard.js';

const MAX_BYTES_PER_URL = 50_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Identity-Atlas-Scraper/1.0';

// ── SSRF address guard ───────────────────────────────────────────────────────
// isBlockedIPv4 / isBlockedAddress / pinnedSafeLookup now live in
// lib/ssrfGuard.js (imported + re-exported at the top of this file).

// Validate a URL for scraping: must be http(s), and a literal IP host must be
// public. (Hostnames are validated at connect time by pinnedSafeLookup.) Throws
// on rejection; returns the parsed URL otherwise.
export function validateScrapeUrl(urlString, base) {
  const u = new URL(urlString, base);
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('Only http(s) URLs are allowed');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw new Error('URLs pointing to private, loopback, or link-local addresses are not allowed');
  }
  return u;
}

function buildAuthHeader(creds) {
  if (!creds) return null;
  if (creds.bearer) return `Bearer ${creds.bearer}`;
  if (creds.username) {
    const userPass = `${creds.username}:${creds.password || ''}`;
    return `Basic ${Buffer.from(userPass, 'utf8').toString('base64')}`;
  }
  return null;
}

// One HTTP(S) GET with the SSRF-safe pinned lookup. Resolves to the response
// (IncomingMessage). Rejects on transport/timeout/blocked-address errors.
function httpGet(urlObj, headers) {
  return new Promise((resolve, reject) => {
    const reqFn = urlObj.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = reqFn(
      urlObj,
      { method: 'GET', headers, lookup: pinnedSafeLookup, timeout: TIMEOUT_MS },
      (res) => resolve(res)
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

// Read a response body up to maxBytes, then stop. Returns { buf, truncated }.
function readCapped(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let truncated = false;
    res.on('data', (chunk) => {
      if (total >= maxBytes) { truncated = true; return; }
      if (total + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - total));
        truncated = true;
        total = maxBytes;
        res.destroy();
      } else {
        chunks.push(chunk);
        total += chunk.length;
      }
    });
    res.on('end', () => resolve({ buf: Buffer.concat(chunks), truncated }));
    res.on('close', () => resolve({ buf: Buffer.concat(chunks), truncated }));
    res.on('error', reject);
  });
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// Crude HTML → text. Removes script/style blocks, drops all tags, decodes a few
// common entities, and collapses whitespace. We intentionally don't pull in a
// real HTML parser — the inputs are best-effort and the LLM is robust to noise.
function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript[^>]*>/gi, ' ')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav[^>]*>/gi, ' ')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header[^>]*>/gi, ' ')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')  // last — so &amp;lt; → &lt; not <
    .replace(/\s+/g, ' ')
    .trim();
}

// Fetch one URL. Returns { url, ok, status, bytes, text, error }.
// Never throws — failures are reported in the result so the caller can show
// per-URL status without aborting the whole batch.
export async function scrapeOne(url, credentials = null) {
  let current;
  try { current = validateScrapeUrl(url); }
  catch (err) { return { url, ok: false, error: err.message }; }

  const auth = buildAuthHeader(credentials);
  const baseHeaders = { 'User-Agent': USER_AGENT, 'Accept': 'text/html,text/plain,*/*;q=0.8' };
  // Auth is only ever sent to the original, operator-supplied origin — never
  // replayed across a redirect to a different origin (credential-leak guard).
  const originForAuth = current.origin;

  try {
    let res;
    for (let hop = 0; ; hop++) {
      const headers = { ...baseHeaders };
      if (auth && current.origin === originForAuth) headers['Authorization'] = auth;
      res = await httpGet(current, headers);

      if (REDIRECT_CODES.has(res.statusCode) && res.headers.location) {
        res.resume(); // drain so the socket can be reused/closed
        if (hop >= MAX_REDIRECTS) return { url, ok: false, error: 'Too many redirects' };
        try { current = validateScrapeUrl(res.headers.location, current); }
        catch (err) { return { url, ok: false, error: `Blocked redirect: ${err.message}` }; }
        continue;
      }
      break;
    }

    const status = res.statusCode;
    if (status < 200 || status >= 300) { res.resume(); return { url, ok: false, status, error: `HTTP ${status}` }; }

    const ct = String(res.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('text/') && !ct.includes('html') && !ct.includes('xml') && !ct.includes('json')) {
      res.resume();
      return { url, ok: false, status, error: `Unsupported content-type: ${ct}` };
    }

    const { buf, truncated } = await readCapped(res, MAX_BYTES_PER_URL);
    const raw = buf.toString('utf8');
    const text = (ct.includes('html') || ct.includes('xml')) ? htmlToText(raw) : raw.replace(/\s+/g, ' ').trim();

    return {
      url,
      ok: true,
      status,
      bytes: buf.length,
      truncated,
      text: text.slice(0, MAX_BYTES_PER_URL), // post-strip text can still be long
    };
  } catch (err) {
    return { url, ok: false, error: err.code === 'ETIMEDOUT' ? 'Request timed out' : err.message };
  }
}

// Fetch a list of URLs sequentially (avoids hammering targets, keeps memory bounded).
// Inputs: [{ url, credentials? }, ...]
// Returns the array in the same order with the scrape results.
export async function scrapeAll(targets) {
  const out = [];
  for (const t of targets || []) {
    out.push(await scrapeOne(t.url, t.credentials));
  }
  return out;
}

// Build a single text blob suitable for stuffing into an LLM context. Each URL
// is delimited so the model can attribute sources back to a specific document.
export function buildLLMContextFromScrapes(results) {
  const okOnes = (results || []).filter((r) => r.ok && r.text);
  if (okOnes.length === 0) return '';
  return okOnes.map((r) => `--- SOURCE: ${r.url} ---\n${r.text}`).join('\n\n');
}
