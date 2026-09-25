// The demo crawler's own configSchema. Generic, type-agnostic engine behaviour
// (maskConfig, VALID_JOB_TYPES discovery) lives in
// app/api/src/routes/jobs.configValidation.test.js — this file only asserts what
// the demo crawler's schema itself accepts.

import { describe, it, expect } from 'vitest';
import { validateCrawlerConfig } from '@api/crawlerManifests.js';

const validateDemo = (config) => validateCrawlerConfig('demo', config);

describe('demo crawler configSchema', () => {
  it('accepts an empty config — the ordinary demo import has no settings', () => {
    expect(validateDemo({})).toBeNull();
  });

  it('accepts includeVolumeData as a boolean, either way', () => {
    expect(validateDemo({ includeVolumeData: true })).toBeNull();
    expect(validateDemo({ includeVolumeData: false })).toBeNull();
  });

  it('rejects a non-boolean includeVolumeData', () => {
    // A stringly-typed "true" must not silently load 520 extra groups into a
    // demo environment (or, worse, silently fail to).
    expect(validateDemo({ includeVolumeData: 'true' })).toBeTruthy();
  });
});

describe('demo crawler configSchema — the realism slice', () => {
  it('accepts includeRealismData as a boolean, either way', () => {
    expect(validateDemo({ includeRealismData: true })).toBeNull();
    expect(validateDemo({ includeRealismData: false })).toBeNull();
  });

  it('rejects a non-boolean includeRealismData', () => {
    // Same reason as the volume slice: a stringly-typed "true" must not quietly
    // load 600 extra people into a demo environment, or quietly not load them.
    expect(validateDemo({ includeRealismData: 'true' })).toBeTruthy();
  });

  it('accepts both slices at once — they are independent', () => {
    expect(validateDemo({ includeVolumeData: true, includeRealismData: true })).toBeNull();
  });
});
