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
// HTML stripping is intentionally crude. The goal is "give the LLM enough text
// to identify the organisation, regulations, processes" — not perfect fidelity.
// We strip script/style/nav, collapse whitespace, and cap at 50 KB per URL to
// keep token usage bounded.

const MAX_BYTES_PER_URL = 50_000;
const TIMEOUT_MS = 15_000;
const USER_AGENT = 'Identity-Atlas-Scraper/1.0';

function buildAuthHeader(creds) {
  if (!creds) return null;
  if (creds.bearer) return `Bearer ${creds.bearer}`;
  if (creds.username) {
    const userPass = `${creds.username}:${creds.password || ''}`;
    return `Basic ${Buffer.from(userPass, 'utf8').toString('base64')}`;
  }
  return null;
}

// Crude HTML → text. Removes script/style blocks, drops all tags, decodes a few
// common entities, and collapses whitespace. We intentionally don't pull in a
// real HTML parser — the inputs are best-effort and the LLM is robust to noise.
function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Fetch one URL. Returns { url, ok, status, bytes, text, error }.
// Never throws — failures are reported in the result so the caller can show
// per-URL status without aborting the whole batch.
export async function scrapeOne(url, credentials = null) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { url, ok: false, error: 'Invalid URL' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { url, ok: false, error: 'Only http(s) URLs are allowed' };
  }

  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,text/plain,*/*;q=0.8',
  };
  const auth = buildAuthHeader(credentials);
  if (auth) headers['Authorization'] = auth;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return { url, ok: false, status: r.status, error: `HTTP ${r.status}` };

    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('text/') && !ct.includes('html') && !ct.includes('xml') && !ct.includes('json')) {
      return { url, ok: false, status: r.status, error: `Unsupported content-type: ${ct}` };
    }

    // Read body up to the cap
    const buf = await r.arrayBuffer();
    const sliced = Buffer.from(buf).slice(0, MAX_BYTES_PER_URL);
    let raw = sliced.toString('utf8');
    let text;
    if (ct.includes('html') || ct.includes('xml')) text = htmlToText(raw);
    else text = raw.replace(/\s+/g, ' ').trim();

    return {
      url,
      ok: true,
      status: r.status,
      bytes: sliced.length,
      truncated: buf.byteLength > MAX_BYTES_PER_URL,
      text: text.slice(0, MAX_BYTES_PER_URL), // post-strip text can still be long
    };
  } catch (err) {
    clearTimeout(timer);
    return { url, ok: false, error: err.name === 'AbortError' ? 'Request timed out' : err.message };
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
  const okOnes = (results || []).filter(r => r.ok && r.text);
  if (okOnes.length === 0) return '';
  return okOnes.map(r => `--- SOURCE: ${r.url} ---\n${r.text}`).join('\n\n');
}
