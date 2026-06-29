// Identity Atlas v5 — LLM provider abstraction.
//
// One small adapter per provider. They all expose the same `chat({system, messages,
// model, temperature, maxTokens})` signature so callers don't care which provider
// is in use. Returns `{ text, usage, model }`.
//
// Supported providers (v1):
//   - anthropic     → api.anthropic.com/v1/messages
//   - openai        → api.openai.com/v1/chat/completions
//   - azure-openai  → {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...
//
// Wire format notes:
//   - Anthropic puts the system prompt as a top-level field, not as a message.
//   - OpenAI and Azure use a `messages` array with role:'system' as the first entry.
//   - Azure OpenAI uses the same body shape as OpenAI but a different URL pattern,
//     a different header name (api-key vs Authorization), and the model name is the
//     deployment name set per-resource.
//
// All adapters use Node's fetch (Node 18+). No external dependencies.
// Network errors and non-2xx responses throw. The response shape is normalised so
// the caller can render `text` and optionally show `usage` token counts.

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.3;

// Allowlist: Azure OpenAI endpoints must match the official hostname pattern.
// Covers Azure Public (.com), US Government (.us), and China (.cn) clouds.
const AZURE_OPENAI_HOST_RE = /^[a-z0-9-]+\.openai\.azure\.(com|us|cn)$/i;

function validateAzureEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') throw new Error('azure-openai: endpoint is required');
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error('azure-openai: invalid endpoint URL'); }
  if (parsed.protocol !== 'https:') throw new Error('azure-openai: endpoint must use HTTPS');
  if (parsed.username || parsed.password) throw new Error('azure-openai: endpoint must not include credentials');
  if (parsed.port) throw new Error('azure-openai: endpoint must not include an explicit port');
  if (parsed.search || parsed.hash) throw new Error('azure-openai: endpoint must not include query string or fragment');
  if (!AZURE_OPENAI_HOST_RE.test(parsed.hostname)) throw new Error('azure-openai: endpoint must be an Azure OpenAI host (*.openai.azure.com / .us / .cn)');
  return parsed;
}


const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  'azure-openai': null, // must be supplied by config (the deployment name)
};

// ─── Shared fetch hardening (M-1) ───────────────────────────────────
// Every outbound provider call goes through llmFetch so a hung or runaway
// provider can't tie up a request indefinitely or exhaust memory:
//   - An AbortController timeout bounds the whole call — connect AND body read,
//     so a slow-drip body is caught too, not just stalled headers.
//   - The body is read with a hard byte cap, so a malicious/buggy provider
//     can't stream an unbounded response into memory.
// Returns { ok, status, bodyText } so each adapter keeps its own status/JSON
// handling (callers JSON.parse bodyText on success, slice it for error text).
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 120_000;
const LLM_MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB — far above any real chat / model-list payload

async function readCappedBody(resp, maxBytes) {
  // Fast reject if the server advertises an over-cap body.
  const declared = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`LLM response too large (${declared} bytes > ${maxBytes}-byte cap)`);
  }
  const reader = resp.body?.getReader?.();
  if (!reader) return resp.text(); // no readable stream; platform already bounded it
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`LLM response exceeded ${maxBytes}-byte cap`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function llmFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const bodyText = await readCappedBody(resp, LLM_MAX_RESPONSE_BYTES);
    return { ok: resp.ok, status: resp.status, bodyText };
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`LLM request timed out after ${Math.round(LLM_TIMEOUT_MS / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Anthropic ──────────────────────────────────────────────────────
async function chatAnthropic({ apiKey, model, system, messages, temperature, maxTokens }) {
  const url = 'https://api.anthropic.com/v1/messages';
  const body = {
    model: model || DEFAULT_MODELS.anthropic,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    temperature: temperature ?? DEFAULT_TEMPERATURE,
    system,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  };
  const { ok, status, bodyText } = await llmFetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!ok) throw new Error(`Anthropic API error ${status}: ${bodyText.slice(0, 500)}`);
  const json = JSON.parse(bodyText);
  const text = (json.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
  return {
    text,
    model: json.model || body.model,
    usage: json.usage ? {
      inputTokens:  json.usage.input_tokens,
      outputTokens: json.usage.output_tokens,
    } : null,
  };
}

// ─── OpenAI ─────────────────────────────────────────────────────────
async function chatOpenAI({ apiKey, model, system, messages, temperature, maxTokens }) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const fullMessages = [
    { role: 'system', content: system },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];
  const body = {
    model: model || DEFAULT_MODELS.openai,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    temperature: temperature ?? DEFAULT_TEMPERATURE,
    messages: fullMessages,
  };
  const { ok, status, bodyText } = await llmFetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!ok) throw new Error(`OpenAI API error ${status}: ${bodyText.slice(0, 500)}`);
  const json = JSON.parse(bodyText);
  return {
    text: json.choices?.[0]?.message?.content || '',
    model: json.model || body.model,
    usage: json.usage ? {
      inputTokens:  json.usage.prompt_tokens,
      outputTokens: json.usage.completion_tokens,
    } : null,
  };
}

// ─── Azure OpenAI ───────────────────────────────────────────────────
async function chatAzureOpenAI({ apiKey, model, system, messages, temperature, maxTokens, endpoint, deployment, apiVersion }) {
  const baseUrl = validateAzureEndpoint(endpoint);
  const dep = deployment || model;
  if (!dep) throw new Error('azure-openai: deployment is required (model field)');
  const ver = apiVersion || '2024-08-01-preview';
  // Construct from the validated parsed URL's origin so static analysis can
  // see the host comes from the allowlist-checked value, not raw user input.
  const requestUrl = new URL(`/openai/deployments/${encodeURIComponent(dep)}/chat/completions`, baseUrl.origin);
  requestUrl.searchParams.set('api-version', ver);
  const fullMessages = [
    { role: 'system', content: system },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];
  const body = {
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    temperature: temperature ?? DEFAULT_TEMPERATURE,
    messages: fullMessages,
  };
  const { ok, status, bodyText } = await llmFetch(requestUrl.href, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!ok) throw new Error(`Azure OpenAI error ${status}: ${bodyText.slice(0, 500)}`);
  const json = JSON.parse(bodyText);
  return {
    text: json.choices?.[0]?.message?.content || '',
    model: json.model || dep,
    usage: json.usage ? {
      inputTokens:  json.usage.prompt_tokens,
      outputTokens: json.usage.completion_tokens,
    } : null,
  };
}

// ─── Dispatcher ─────────────────────────────────────────────────────
//
// Generic chat call. The caller passes a config object describing which provider
// to use and the credentials/parameters for it. The dispatch is a single switch.
//
// config shape:
//   { provider: 'anthropic'|'openai'|'azure-openai',
//     apiKey:    string,
//     model?:    string,           // for azure-openai this is the deployment name
//     endpoint?: string,           // azure-openai only
//     apiVersion?: string }        // azure-openai only
//
// args:
//   { system, messages: [{role, content}], temperature?, maxTokens? }
export async function chat(config, args) {
  if (!config || !config.provider) throw new Error('LLM config missing provider');
  if (!config.apiKey)              throw new Error('LLM config missing apiKey');

  const merged = {
    apiKey:    config.apiKey,
    model:     args.model || config.model,
    system:    args.system,
    messages:  args.messages,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
    endpoint:  config.endpoint,
    deployment: config.deployment,
    apiVersion: config.apiVersion,
  };

  switch (config.provider) {
    case 'anthropic':    return chatAnthropic(merged);
    case 'openai':       return chatOpenAI(merged);
    case 'azure-openai': return chatAzureOpenAI(merged);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}

// ─── Model discovery ────────────────────────────────────────────────
//
// Lists the models available for a given provider + credentials. Used by the
// Admin → LLM Settings page to populate the model dropdown instead of making
// the user type the exact model ID.
//
// Each provider has a different shape and different "model" semantics:
//   - anthropic:    GET /v1/models → {data: [{id, display_name, created_at}]}
//   - openai:       GET /v1/models → {data: [{id, created, owned_by}]}
//   - azure-openai: GET {endpoint}/openai/deployments?api-version=... — returns
//                   deployments (the user-chosen name), not underlying models.
//                   The user still needs to know which deployment to use.
//
// Return shape: { models: [{id, label?}] } — `id` is what gets passed to
// chat() as the `model` field, `label` is an optional human-friendly name.

// Rank Anthropic Claude models by capability tier (biggest/most expensive first).
// Opus > Sonnet > Haiku. Within a family, higher version + newer date wins.
// Returns a negative number for "more capable" (sorts first in ascending order).
function rankAnthropicModel(id) {
  const lower = id.toLowerCase();
  // Family tier: lower = more capable / more expensive
  let family = 9;
  if      (lower.includes('opus'))   family = 0;
  else if (lower.includes('sonnet')) family = 1;
  else if (lower.includes('haiku'))  family = 2;
  // Version number (claude-4, claude-3.7, etc.) — higher version = better
  // eslint-disable-next-line security/detect-unsafe-regex -- static pattern; \d+ and [.-] are disjoint, no catastrophic backtracking
  const versionMatch = lower.match(/claude[- ]?(\d+(?:[.-]\d+)?)/);
  const version = versionMatch ? parseFloat(versionMatch[1].replace('-', '.')) : 0;
  // Date suffix (YYYYMMDD) — newer = better tiebreaker
  const dateMatch = lower.match(/(\d{8})/);
  const date = dateMatch ? parseInt(dateMatch[1], 10) : 0;
  // Compose a sortable tuple: family * 1e12 - version * 1e9 - date
  // Lower result = more capable model → appears first in ascending sort
  return family * 1e12 - version * 1e9 - date;
}

// Speed/cost hint for Anthropic models — shown in the dropdown so the user
// understands the tradeoff. Opus is slow+expensive+highest quality, Haiku is
// fast+cheap+lower quality. These are rough heuristics, not exact numbers.
function anthropicSpeedHint(id) {
  const lower = id.toLowerCase();
  if (lower.includes('opus'))   return 'slow · highest quality';
  if (lower.includes('sonnet')) return 'balanced';
  if (lower.includes('haiku'))  return 'fast · lower quality';
  return '';
}

async function listModelsAnthropic({ apiKey }) {
  const { ok, status, bodyText } = await llmFetch('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  if (!ok) throw new Error(`Anthropic models API error ${status}: ${bodyText.slice(0, 300)}`);
  const json = JSON.parse(bodyText);
  const models = (json.data || [])
    .filter(m => m.id)
    .map(m => {
      const base = m.display_name || m.id;
      const hint = anthropicSpeedHint(m.id);
      return { id: m.id, label: hint ? `${base} — ${hint}` : base };
    })
    .sort((a, b) => rankAnthropicModel(a.id) - rankAnthropicModel(b.id));
  return { models };
}

// Rank OpenAI models by capability tier (biggest first).
// GPT-5 > GPT-4.5 > o-series (reasoning) > GPT-4o > GPT-4 > GPT-3.5.
// "mini" and "nano" variants rank below their full counterparts.
function rankOpenAIModel(id) {
  const lower = id.toLowerCase();
  let family = 9;
  if      (lower.startsWith('gpt-5'))        family = 0;
  else if (lower.startsWith('gpt-4.5'))      family = 1;
  else if (/^o[1-9]/i.test(lower))           family = 2;  // o1, o3, o4 reasoning models
  else if (lower.startsWith('gpt-4o'))       family = 3;
  else if (lower.startsWith('gpt-4-turbo'))  family = 4;
  else if (lower.startsWith('gpt-4'))        family = 5;
  else if (lower.startsWith('gpt-3.5'))      family = 6;
  // Mini/nano variants drop one tier below the base
  let variant = 0;
  if      (lower.includes('nano'))  variant = 2;
  else if (lower.includes('mini'))  variant = 1;
  // Date suffix for tiebreak (newest first)
  const dateMatch = lower.match(/(\d{4}-?\d{2}-?\d{2})/);
  const date = dateMatch ? parseInt(dateMatch[1].replace(/-/g, ''), 10) : 0;
  return family * 1e12 + variant * 1e10 - date;
}

// Speed/cost hint for OpenAI models
function openAISpeedHint(id) {
  const lower = id.toLowerCase();
  if (lower.includes('nano'))                    return 'fastest · lowest quality';
  if (lower.includes('mini'))                    return 'fast · balanced';
  if (/^o[1-9]/i.test(lower))                    return 'slow · reasoning (thinks before answering)';
  if (lower.startsWith('gpt-5'))                 return 'slow · highest quality';
  if (lower.startsWith('gpt-4.5'))               return 'slow · high quality';
  if (lower.startsWith('gpt-4o'))                return 'balanced';
  if (lower.startsWith('gpt-4-turbo'))           return 'balanced';
  if (lower.startsWith('gpt-4'))                 return 'slower · high quality';
  if (lower.startsWith('gpt-3.5'))               return 'fast · lower quality';
  return '';
}

async function listModelsOpenAI({ apiKey }) {
  const { ok, status, bodyText } = await llmFetch('https://api.openai.com/v1/models', {
    headers: { 'authorization': `Bearer ${apiKey}` },
  });
  if (!ok) throw new Error(`OpenAI models API error ${status}: ${bodyText.slice(0, 300)}`);
  const json = JSON.parse(bodyText);
  // Filter to chat-capable models
  const models = (json.data || [])
    .filter(m => m.id && /^(gpt-|o[1-9])/i.test(m.id))
    .map(m => {
      const hint = openAISpeedHint(m.id);
      return { id: m.id, label: hint ? `${m.id} — ${hint}` : m.id };
    })
    .sort((a, b) => rankOpenAIModel(a.id) - rankOpenAIModel(b.id));
  return { models };
}

async function listModelsAzureOpenAI({ apiKey, endpoint, apiVersion }) {
  const baseUrl = validateAzureEndpoint(endpoint);
  const ver = apiVersion || '2024-08-01-preview';
  const requestUrl = new URL('/openai/deployments', baseUrl.origin);
  requestUrl.searchParams.set('api-version', ver);
  const { ok, status, bodyText } = await llmFetch(requestUrl.href, { headers: { 'api-key': apiKey } });
  if (!ok) throw new Error(`Azure OpenAI deployments API error ${status}: ${bodyText.slice(0, 300)}`);
  const json = JSON.parse(bodyText);
  // Azure returns deployments — each `id` is the deployment name to use as `model`
  const models = (json.data || [])
    .filter(d => d.id)
    .map(d => ({ id: d.id, label: d.model ? `${d.id} (${d.model})` : d.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { models };
}

export async function listModels(config) {
  if (!config || !config.provider) throw new Error('LLM config missing provider');
  if (!config.apiKey)              throw new Error('LLM config missing apiKey');
  switch (config.provider) {
    case 'anthropic':    return listModelsAnthropic(config);
    case 'openai':       return listModelsOpenAI(config);
    case 'azure-openai': return listModelsAzureOpenAI(config);
    default: throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}

export const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'azure-openai'];
export { DEFAULT_MODELS };
