/**
 * Tests for custom-connector's crawler.json configSchema — exercised through the
 * generic, manifest-driven validateCrawlerConfig() engine. custom-connector has
 * an empty schema (no properties, no required fields): any config is accepted.
 * This is the wiring smoke test for the per-crawler configValidation tests.
 */
import { describe, it, expect } from 'vitest';
import { validateCrawlerConfig } from '@api/crawlerManifests.js';

const validate = (config) => validateCrawlerConfig('custom-connector', config);

describe('validateCrawlerConfig (custom-connector)', () => {
  it('accepts an empty config (no required fields)', () => {
    expect(validate({})).toBeNull();
  });

  it('accepts an arbitrary config', () => {
    expect(validate({ anything: 'goes', n: 1 })).toBeNull();
  });
});
