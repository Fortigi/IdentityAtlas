/**
 * Tests for entra-id's crawler.json configSchema — service-principal auth
 * (tenantId/clientId/clientSecret always required), exercised through the
 * manifest-driven validateCrawlerConfig() engine.
 */
import { describe, it, expect } from 'vitest';
import { validateCrawlerConfig } from '@api/crawlerManifests.js';

const v = (config) => validateCrawlerConfig('entra-id', config);

describe('validateCrawlerConfig (entra-id)', () => {
  it('valid with tenantId + clientId + clientSecret', () => {
    expect(v({ tenantId: 't', clientId: 'c', clientSecret: 's' })).toBeNull();
  });

  it('errors when all fields are missing', () => {
    expect(v({})).toMatch(/tenantId|clientId|clientSecret/);
  });
  it('errors without clientSecret', () => {
    expect(v({ tenantId: 't', clientId: 'c' })).toMatch(/clientSecret/);
  });
  it('errors without clientId', () => {
    expect(v({ tenantId: 't', clientSecret: 's' })).toMatch(/clientId/);
  });
});
