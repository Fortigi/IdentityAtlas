// Identity Atlas v5 — Generic HTTP API adapter for external risk scoring.
//
// This adapter enables integration with any customer-owned scoring system that
// exposes an HTTP endpoint. The adapter POSTs batches of entity summaries and
// expects normalised scores in the response.
//
// Expected response format:
//   { "scores": [{ "entityId": "uuid", "entityType": "Principal"|"Resource",
//                   "score": 0-100, "explanation": "..." }] }
//
// Plugin config shape (stored in RiskPlugins.config JSONB):
//   {
//     "requestPath":  "/api/score",          // appended to endpointUrl
//     "method":       "POST",                // default POST
//     "batchSize":    500,                   // entities per request
//     "timeoutMs":    30000,                 // per-request timeout
//     "headers":      { "X-Custom": "val" }, // additional headers
//     "entityTypes":  ["Principal", "Resource"]  // which types to send
//   }

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Health check ────────────────────────────────────────────────────

export async function checkHealth(plugin) {
  const config = plugin.config || {};
  const url = buildUrl(plugin, '/health');
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(plugin),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Score fetching ──────────────────────────────────────────────────

export async function fetchScores(plugin, entities) {
  const config = plugin.config || {};
  const batchSize = config.batchSize || DEFAULT_BATCH_SIZE;
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  const method = (config.method || 'POST').toUpperCase();
  const allowedTypes = config.entityTypes || ['Principal', 'Resource'];

  // Filter to requested entity types
  const filtered = entities.filter(e => allowedTypes.includes(e.type));
  if (filtered.length === 0) return [];

  const allScores = [];

  // Send in batches
  for (let i = 0; i < filtered.length; i += batchSize) {
    const batch = filtered.slice(i, i + batchSize);
    const payload = {
      entities: batch.map(e => ({
        entityId: e.id,
        entityType: e.type,
        displayName: e.displayName,
      })),
    };

    try {
      const url = buildUrl(plugin, config.requestPath || '/api/score');
      const res = await fetch(url, {
        method,
        headers: { ...buildHeaders(plugin), 'Content-Type': 'application/json' },
        body: method !== 'GET' ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        console.warn(`HTTP plugin ${plugin.displayName}: batch ${i} failed with HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const scores = data.scores || data.data || [];

      for (const s of scores) {
        // Validate and normalise
        const score = Math.max(0, Math.min(100, Math.round(Number(s.score) || 0)));
        if (score === 0) continue;

        allScores.push({
          entityId: s.entityId,
          entityType: s.entityType || 'Principal',
          score,
          rawScore: s.rawScore ?? s.score,
          explanation: typeof s.explanation === 'object' ? s.explanation
                     : s.explanation ? { detail: s.explanation }
                     : null,
        });
      }
    } catch (err) {
      console.warn(`HTTP plugin ${plugin.displayName}: batch ${i} error:`, err.message);
    }
  }

  return allScores;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function buildUrl(plugin, path) {
  const base = (plugin.endpointUrl || '').replace(/\/+$/, '');
  const suffix = (path || '').replace(/^\/+/, '/');
  return `${base}${suffix}`;
}

function buildHeaders(plugin) {
  const headers = { Accept: 'application/json' };
  if (plugin.apiKey) {
    headers.Authorization = `Bearer ${plugin.apiKey}`;
  }
  const config = plugin.config || {};
  if (config.headers && typeof config.headers === 'object') {
    Object.assign(headers, config.headers);
  }
  return headers;
}
