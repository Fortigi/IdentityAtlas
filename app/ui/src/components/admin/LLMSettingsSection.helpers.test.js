import { describe, it, expect } from 'vitest';
import { providerLabel, buildConfigBody, seedConfig } from './LLMSettingsSection.helpers';

describe('providerLabel', () => {
  it('maps the known provider ids to friendly names', () => {
    expect(providerLabel('azure-openai')).toBe('Azure OpenAI');
    expect(providerLabel('anthropic')).toBe('Anthropic Claude');
    expect(providerLabel('openai')).toBe('OpenAI');
  });

  it('falls back to OpenAI for an unknown provider', () => {
    expect(providerLabel('something-else')).toBe('OpenAI');
    expect(providerLabel(undefined)).toBe('OpenAI');
  });
});

describe('buildConfigBody', () => {
  const base = { provider: 'anthropic', model: 'claude-3', endpoint: 'e', deployment: 'd', apiVersion: 'v', apiKey: 'sk' };

  it('nulls the azure-only fields for a non-azure provider and never leaks the apiKey', () => {
    const body = buildConfigBody(base, false);
    expect(body).toEqual({ provider: 'anthropic', model: 'claude-3', endpoint: null, deployment: null, apiVersion: null });
    expect(body).not.toHaveProperty('apiKey');
  });

  it('keeps the azure fields when isAzure is true', () => {
    const body = buildConfigBody({ ...base, provider: 'azure-openai' }, true);
    expect(body).toEqual({ provider: 'azure-openai', model: 'claude-3', endpoint: 'e', deployment: 'd', apiVersion: 'v' });
  });

  it('coerces empty strings to null', () => {
    const body = buildConfigBody({ provider: 'openai', model: '', endpoint: '', deployment: '', apiVersion: '' }, true);
    expect(body).toEqual({ provider: 'openai', model: null, endpoint: null, deployment: null, apiVersion: null });
  });
});

describe('seedConfig', () => {
  it('applies server values over the previous config and blanks the apiKey', () => {
    const prev = { provider: 'x', model: 'x', endpoint: 'x', deployment: 'x', apiVersion: 'x', apiKey: 'typed' };
    const seeded = seedConfig(prev, { provider: 'openai', model: 'gpt-4o', endpoint: 'ep', deployment: 'dep', apiVersion: 'ver' });
    expect(seeded).toEqual({ provider: 'openai', model: 'gpt-4o', endpoint: 'ep', deployment: 'dep', apiVersion: 'ver', apiKey: '' });
  });

  it('defaults missing server fields (provider → anthropic, rest → empty)', () => {
    const seeded = seedConfig({ apiKey: 'k' }, {});
    expect(seeded).toEqual({ provider: 'anthropic', model: '', endpoint: '', deployment: '', apiVersion: '', apiKey: '' });
  });
});
