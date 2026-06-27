/**
 * Tests for csv's crawler.json configSchema — no required fields; the optional
 * fields (csvFolder, systemName, systemType) are typed strings. Exercised through
 * the manifest-driven validateCrawlerConfig() engine.
 */
import { describe, it, expect } from 'vitest';
import { validateCrawlerConfig } from '@api/crawlerManifests.js';

const v = (config) => validateCrawlerConfig('csv', config);

describe('validateCrawlerConfig (csv)', () => {
  it('accepts an empty config (no required fields)', () => {
    expect(v({})).toBeNull();
  });

  it('accepts the optional fields', () => {
    expect(v({ csvFolder: '/data/csv', systemName: 'HR', systemType: 'csv' })).toBeNull();
  });

  it('errors when csvFolder has the wrong type', () => {
    expect(v({ csvFolder: 123 })).toMatch(/csvFolder/);
  });
});
