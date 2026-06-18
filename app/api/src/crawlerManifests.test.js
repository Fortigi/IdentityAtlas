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

vi.mock('./secrets/crawlerSecrets.js', () => ({ hasConfigSecret: vi.fn() }));

import { hasConfigSecret } from './secrets/crawlerSecrets.js';
import { validateCrawlerConfig, validateStoredCrawlerConfig } from './crawlerManifests.js';

describe('validateStoredCrawlerConfig', () => {
  beforeEach(() => {
    hasConfigSecret.mockReset();
  });

  it('returns null without consulting the vault when the config already validates', async () => {
    const config = { baseUrl: 'https://omada.example.com', authMethod: 'FormCookie', username: 'a', password: 'b' };
    expect(validateCrawlerConfig('omada', config)).toBeNull(); // sanity: passes on its own
    expect(await validateStoredCrawlerConfig('omada', config, 1)).toBeNull();
    expect(hasConfigSecret).not.toHaveBeenCalled();
  });

  it('returns the original error unchanged when the failure is unrelated to clientSecret', async () => {
    const config = { authMethod: 'FormCookie' }; // missing baseUrl
    const err = await validateStoredCrawlerConfig('omada', config, 1);
    expect(err).toMatch(/baseUrl/);
    expect(hasConfigSecret).not.toHaveBeenCalled();
  });

  it('does not consult the vault when no configId is given (inline submission)', async () => {
    const config = { baseUrl: 'https://omada.example.com', authMethod: 'OAuth2CC', tokenEndpoint: 't', clientId: 'c' };
    const err = await validateStoredCrawlerConfig('omada', config, undefined);
    expect(err).toMatch(/clientSecret/);
    expect(hasConfigSecret).not.toHaveBeenCalled();
  });

  it('returns the original error when clientSecret is missing and the vault has nothing either', async () => {
    hasConfigSecret.mockResolvedValue(false);
    const config = { baseUrl: 'https://omada.example.com', authMethod: 'OAuth2CC', tokenEndpoint: 't', clientId: 'c' };
    const err = await validateStoredCrawlerConfig('omada', config, 42);
    expect(err).toMatch(/clientSecret/);
    expect(hasConfigSecret).toHaveBeenCalledWith(42);
  });

  it('resolves via the vault and passes when clientSecret is missing from the JSON but present in the vault (omada OAuth2CC)', async () => {
    hasConfigSecret.mockResolvedValue(true);
    const config = { baseUrl: 'https://omada.example.com', authMethod: 'OAuth2CC', tokenEndpoint: 't', clientId: 'c' };
    expect(await validateStoredCrawlerConfig('omada', config, 7)).toBeNull();
    expect(hasConfigSecret).toHaveBeenCalledWith(7);
  });

  it('resolves via the vault and passes for entra-id the same way', async () => {
    hasConfigSecret.mockResolvedValue(true);
    const config = { tenantId: 't', clientId: 'c' }; // no clientSecret — vaulted
    expect(await validateStoredCrawlerConfig('entra-id', config, 9)).toBeNull();
    expect(hasConfigSecret).toHaveBeenCalledWith(9);
  });

  it('still fails entra-id when the vault genuinely has no secret', async () => {
    hasConfigSecret.mockResolvedValue(false);
    const config = { tenantId: 't', clientId: 'c' };
    const err = await validateStoredCrawlerConfig('entra-id', config, 10);
    expect(err).toMatch(/clientSecret/);
  });

  it('never injects a placeholder when clientSecret is already present', async () => {
    const config = { tenantId: 't', clientId: 'c', clientSecret: 'real-value' };
    expect(await validateStoredCrawlerConfig('entra-id', config, 11)).toBeNull();
    expect(hasConfigSecret).not.toHaveBeenCalled();
  });
});
