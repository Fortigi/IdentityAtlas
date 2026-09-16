/**
 * Tests for validateStoredCrawlerConfig — the vault-aware wrapper around
 * validateCrawlerConfig used by every caller that validates a config already
 * loaded from CrawlerConfigs (an edit, a "Run Now", a scheduled run) rather
 * than a fresh wizard submission. Regression coverage for the bug where
 * editing/running/scheduling a crawler whose schema requires clientSecret
 * (entra-id; omada and midPoint's OAuth2CC/OAuth2ROPC) failed validation
 * every time, because clientSecret is deliberately stripped from the stored
 * config JSON — it lives only in the secrets vault.
 *
 * Uses real manifests (omada, entra-id) the same way jobs.configValidation.test.js
 * already does for validateCrawlerConfig — no crawler-type branching in the
 * code under test, so real schemas are the simplest fixtures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./secrets/crawlerSecrets.js', () => ({
  vaultedConfigFields: vi.fn(),
  CONFIG_SECRET_FIELDS: ['clientSecret', 'password', 'apiToken', 'cookieString'],
}));

import { vaultedConfigFields } from './secrets/crawlerSecrets.js';
import { validateCrawlerConfig, validateStoredCrawlerConfig, isSingletonJob, isPushModeType, getPushModeType, isExperimentalType, getUrlFields, _crawlerManifests } from './crawlerManifests.js';

describe('validateStoredCrawlerConfig', () => {
  beforeEach(() => {
    vaultedConfigFields.mockReset();
  });

  it('returns null without consulting the vault when the config already validates', async () => {
    const config = { baseUrl: 'https://omada.example.com', authMethod: 'FormCookie', username: 'a', password: 'b' };
    expect(validateCrawlerConfig('omada', config)).toBeNull(); // sanity: passes on its own
    expect(await validateStoredCrawlerConfig('omada', config, 1)).toBeNull();
    expect(vaultedConfigFields).not.toHaveBeenCalled();
  });

  it('returns the original error unchanged when the failure is unrelated to a credential field', async () => {
    const config = { authMethod: 'FormCookie', username: 'a', password: 'b' }; // missing baseUrl
    const err = await validateStoredCrawlerConfig('omada', config, 1);
    expect(err).toMatch(/baseUrl/);
    expect(vaultedConfigFields).not.toHaveBeenCalled();
  });

  it('does not consult the vault when no configId is given (inline submission)', async () => {
    const config = { baseUrl: 'https://omada.example.com', authMethod: 'OAuth2CC', tokenEndpoint: 't', clientId: 'c' };
    const err = await validateStoredCrawlerConfig('omada', config, undefined);
    expect(err).toMatch(/clientSecret/);
    expect(vaultedConfigFields).not.toHaveBeenCalled();
  });

  it('returns the original error when clientSecret is missing and the vault has nothing either', async () => {
    vaultedConfigFields.mockResolvedValue([]);
    const config = { baseUrl: 'https://omada.example.com', authMethod: 'OAuth2CC', tokenEndpoint: 't', clientId: 'c' };
    const err = await validateStoredCrawlerConfig('omada', config, 42);
    expect(err).toMatch(/clientSecret/);
    expect(vaultedConfigFields).toHaveBeenCalledWith(42);
  });

  it('resolves via the vault and passes when clientSecret is missing from the JSON but present in the vault (omada OAuth2CC)', async () => {
    vaultedConfigFields.mockResolvedValue(['clientSecret']);
    const config = { baseUrl: 'https://omada.example.com', authMethod: 'OAuth2CC', tokenEndpoint: 't', clientId: 'c' };
    expect(await validateStoredCrawlerConfig('omada', config, 7)).toBeNull();
    expect(vaultedConfigFields).toHaveBeenCalledWith(7);
  });

  it('resolves via the vault and passes for entra-id the same way', async () => {
    vaultedConfigFields.mockResolvedValue(['clientSecret']);
    const config = { tenantId: 't', clientId: 'c' }; // no clientSecret — vaulted
    expect(await validateStoredCrawlerConfig('entra-id', config, 9)).toBeNull();
    expect(vaultedConfigFields).toHaveBeenCalledWith(9);
  });

  it('still fails entra-id when the vault genuinely has no secret', async () => {
    vaultedConfigFields.mockResolvedValue(['password']); // a different field is vaulted
    const config = { tenantId: 't', clientId: 'c' };
    const err = await validateStoredCrawlerConfig('entra-id', config, 10);
    expect(err).toMatch(/clientSecret/);
  });

  it('never injects a placeholder when clientSecret is already present', async () => {
    const config = { tenantId: 't', clientId: 'c', clientSecret: 'real-value' };
    expect(await validateStoredCrawlerConfig('entra-id', config, 11)).toBeNull();
    expect(vaultedConfigFields).not.toHaveBeenCalled();
  });

  // SEC-2026-09 M-10: password / apiToken / cookieString are vaulted per config too.
  it('passes an omada BasicAuth config whose password lives only in the vault', async () => {
    vaultedConfigFields.mockResolvedValue(['password']);
    const config = { baseUrl: 'https://omada.example.com', authMethod: 'BasicAuth', username: 'u' };
    expect(await validateStoredCrawlerConfig('omada', config, 12)).toBeNull();
  });

  it('passes an omada ApiToken config whose token lives only in the vault', async () => {
    vaultedConfigFields.mockResolvedValue(['apiToken']);
    const config = { baseUrl: 'https://omada.example.com', authMethod: 'ApiToken' };
    expect(await validateStoredCrawlerConfig('omada', config, 13)).toBeNull();
  });

  it('fails OAuth2ROPC when only one of its two required credentials is vaulted', async () => {
    vaultedConfigFields.mockResolvedValue(['clientSecret']);
    const config = { baseUrl: 'https://omada.example.com', authMethod: 'OAuth2ROPC', tokenEndpoint: 't', clientId: 'c', username: 'u' };
    expect(await validateStoredCrawlerConfig('omada', config, 14)).toMatch(/password/);
  });
});

// Manifest-driven capability flags. These let core code (routes/jobs.js,
// routes/crawlers.js) avoid hardcoded `=== '<type>'` checks — the drift the
// crawler-manifest CI check now blocks in app/api/src. Asserted against the
// real manifests so the flags staying set in crawler.json is part of the test.
describe('capability flags', () => {
  it('isSingletonJob is true for the demo dataset, false for a normal pull crawler', () => {
    expect(isSingletonJob('demo')).toBe(true);
    expect(isSingletonJob('entra-id')).toBe(false);
  });

  it('isSingletonJob is false for an unknown type (no manifest)', () => {
    expect(isSingletonJob('does-not-exist')).toBe(false);
  });

  it('isPushModeType is true for the custom connector, false for a pull crawler', () => {
    expect(isPushModeType('custom-connector')).toBe(true);
    expect(isPushModeType('omada')).toBe(false);
  });

  it('getPushModeType resolves to the single push-mode crawler', () => {
    expect(getPushModeType()).toBe('custom-connector');
  });

  it('isExperimentalType is true for SCIM and false for every shipped non-experimental crawler', () => {
    expect(isExperimentalType('scim')).toBe(true);
    for (const type of ['entra-id', 'omada', 'midpoint', 'csv', 'custom-connector']) {
      expect(isExperimentalType(type)).toBe(false);
    }
  });

  it('getUrlFields lists the credential-bearing URL fields of the REST connectors, and nothing for the rest', () => {
    for (const type of ['omada', 'odata', 'midpoint', 'scim']) {
      expect(getUrlFields(type), type).toEqual(['baseUrl', 'tokenEndpoint']);
    }
    for (const type of ['entra-id', 'azure-rm', 'csv', 'demo', 'custom-connector', 'does-not-exist']) {
      expect(getUrlFields(type), type).toEqual([]);
    }
  });

  it('getUrlFields ignores a malformed declaration instead of treating a string as a field list', () => {
    _crawlerManifests['fixture-malformed-urlfields'] = { urlFields: 'baseUrl' };
    _crawlerManifests['fixture-mixed-urlfields'] = { urlFields: ['baseUrl', 7, null] };
    try {
      expect(getUrlFields('fixture-malformed-urlfields')).toEqual([]);
      expect(getUrlFields('fixture-mixed-urlfields')).toEqual(['baseUrl']);
    } finally {
      delete _crawlerManifests['fixture-malformed-urlfields'];
      delete _crawlerManifests['fixture-mixed-urlfields'];
    }
  });

  it('isExperimentalType is false for an unknown type (no manifest)', () => {
    expect(isExperimentalType('does-not-exist')).toBe(false);
  });
});

describe('manifest maps ignore inherited property names (SEC-2026-09 L-15)', () => {
  it('an inherited name has no manifest and no validator', () => {
    expect(validateCrawlerConfig('hasOwnProperty', {})).toBeNull();
    expect(validateCrawlerConfig('constructor', {})).toBeNull();
    expect(isPushModeType('__proto__')).toBe(false);
    expect(isSingletonJob('toString')).toBe(false);
  });
});
