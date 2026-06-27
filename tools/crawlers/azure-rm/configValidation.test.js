/**
 * Tests for azure-rm's crawler.json configSchema — service-principal auth
 * (tenantId/clientId/clientSecret always required), exercised through the
 * manifest-driven validateCrawlerConfig() engine.
 */
import { describe, it, expect } from 'vitest';
import { validateCrawlerConfig } from '@api/crawlerManifests.js';

const v = (config) => validateCrawlerConfig('azure-rm', config);
const base = { tenantId: 't', clientId: 'c', clientSecret: 's' };

describe('validateCrawlerConfig (azure-rm)', () => {
  it('valid with tenantId + clientId + clientSecret', () => {
    expect(v(base)).toBeNull();
  });

  it('errors without clientSecret', () => {
    expect(v({ tenantId: 't', clientId: 'c' })).toMatch(/clientSecret/);
  });
  it('errors without tenantId', () => {
    expect(v({ clientId: 'c', clientSecret: 's' })).toMatch(/tenantId/);
  });

  it('accepts the optional scoping fields', () => {
    expect(v({ ...base, subscriptionIds: ['sub-1'], includeResourceLevel: true, includeCustomRoles: false })).toBeNull();
  });

  it('errors when subscriptionIds is not an array', () => {
    expect(v({ ...base, subscriptionIds: 'sub-1' })).toMatch(/subscriptionIds/);
  });
  it('errors when includeResourceLevel is not a boolean', () => {
    expect(v({ ...base, includeResourceLevel: 'yes' })).toMatch(/includeResourceLevel/);
  });
});
