// Pure helpers for LLMSettingsSection — request-body shaping, provider labels
// and the form-seeding transform. Kept out of the component so each is trivially
// unit-testable and the component body stays flat.

// Human-readable name for a provider id, used in the Provider <select>.
const PROVIDER_LABELS = {
  'azure-openai': 'Azure OpenAI',
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI',
};

export function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || 'OpenAI';
}

// The config payload shared by the Save (PUT) and Test (POST) requests. The API
// key is added by the caller only when the user typed one — never shaped here.
// Azure-only fields collapse to null for the other providers.
export function buildConfigBody(config, isAzure) {
  return {
    provider: config.provider,
    model: config.model || null,
    endpoint: isAzure ? config.endpoint || null : null,
    deployment: isAzure ? config.deployment || null : null,
    apiVersion: isAzure ? config.apiVersion || null : null,
  };
}

// Re-seed the editable form from a freshly loaded server config. The API key is
// never returned by the server, so it always resets to blank.
export function seedConfig(prev, serverConfig) {
  return {
    ...prev,
    provider: serverConfig.provider || 'anthropic',
    model: serverConfig.model || '',
    endpoint: serverConfig.endpoint || '',
    deployment: serverConfig.deployment || '',
    apiVersion: serverConfig.apiVersion || '',
    apiKey: '',
  };
}
