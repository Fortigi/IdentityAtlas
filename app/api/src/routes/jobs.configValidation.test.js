/**
 * Unit tests for the generic config-validation/masking engine in jobs.js:
 *   - maskConfig: redacts known secret fields, regardless of crawler type
 *   - validateCrawlerConfig: manifest-driven JSON-schema validation, generic
 *     across all crawler types
 *   - VALID_JOB_TYPES: built from the manifest scan at startup
 *
 * Schema behavior specific to one crawler type (e.g. which fields each auth
 * method requires) is tested next to that crawler's own crawler.json, not
 * here — see tools/crawlers/omada/configValidation.test.js for an example.
 */
import { describe, it, expect } from 'vitest';
import { maskConfig, validateCrawlerConfig, VALID_JOB_TYPES } from './jobs.js';

const SECRET_MASK = '••••••••';

describe('VALID_JOB_TYPES — manifest discovery', () => {
  it('contains all baseline crawler types', () => {
    expect(VALID_JOB_TYPES).toEqual(expect.arrayContaining(['demo', 'entra-id', 'csv', 'omada']));
  });

  it('contains odata (proves manifests loaded — odata is not in the hardcoded fallback)', () => {
    expect(VALID_JOB_TYPES).toContain('odata');
  });
});

describe('validateCrawlerConfig — type coverage', () => {
  it('returns null for an unknown/unregistered type (no schema = no validation)', () => {
    expect(validateCrawlerConfig('unknown-type', {})).toBeNull();
  });

  it('returns null for a type with no configSchema (csv has none)', () => {
    expect(validateCrawlerConfig('csv', {})).toBeNull();
  });
});

describe('maskConfig', () => {
  it('returns null for null input', () => {
    expect(maskConfig(null)).toBeNull();
  });

  it('masks clientSecret', () => {
    const out = maskConfig({ clientSecret: 'super-secret' });
    expect(out.clientSecret).toBe(SECRET_MASK);
  });

  it('masks password', () => {
    const out = maskConfig({ password: 'hunter2' });
    expect(out.password).toBe(SECRET_MASK);
  });

  it('masks apiToken', () => {
    const out = maskConfig({ apiToken: 'tok_abc123' });
    expect(out.apiToken).toBe(SECRET_MASK);
  });

  it('masks cookieString', () => {
    const out = maskConfig({ cookieString: 'session=abc; auth=xyz' });
    expect(out.cookieString).toBe(SECRET_MASK);
  });

  it('does not mask non-secret fields', () => {
    const out = maskConfig({ baseUrl: 'https://example.com', authMethod: 'FormCookie' });
    expect(out.baseUrl).toBe('https://example.com');
    expect(out.authMethod).toBe('FormCookie');
  });

  it('accepts a JSON string as input', () => {
    const out = maskConfig(JSON.stringify({ clientSecret: 'secret', baseUrl: 'http://x' }));
    expect(out.clientSecret).toBe(SECRET_MASK);
    expect(out.baseUrl).toBe('http://x');
  });

  it('leaves absent secret fields absent', () => {
    const out = maskConfig({ baseUrl: 'http://x' });
    expect('password' in out).toBe(false);
    expect('apiToken' in out).toBe(false);
  });
});
