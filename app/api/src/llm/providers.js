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

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  'azure-openai': null, // must be supplied by config (the deployment name)
};

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
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Anthropic API error ${r.status}: ${errBody.slice(0, 500)}`);
  }
  const json = await r.json();
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
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`OpenAI API error ${r.status}: ${errBody.slice(0, 500)}`);
  }
  const json = await r.json();
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
  if (!endpoint) throw new Error('azure-openai: endpoint is required');
  const dep = deployment || model;
  if (!dep) throw new Error('azure-openai: deployment is required (model field)');
  const ver = apiVersion || '2024-08-01-preview';
  const cleanEndpoint = endpoint.replace(/\/+$/, '');
  const url = `${cleanEndpoint}/openai/deployments/${encodeURIComponent(dep)}/chat/completions?api-version=${encodeURIComponent(ver)}`;
  const fullMessages = [
    { role: 'system', content: system },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];
  const body = {
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    temperature: temperature ?? DEFAULT_TEMPERATURE,
    messages: fullMessages,
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Azure OpenAI error ${r.status}: ${errBody.slice(0, 500)}`);
  }
  const json = await r.json();
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

export const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'azure-openai'];
export { DEFAULT_MODELS };
