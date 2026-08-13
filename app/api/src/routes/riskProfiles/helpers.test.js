// Unit tests for the pure riskProfiles helpers (#1035). resolveScrapeTargets +
// findInvalidClassifierPatterns are covered through riskProfiles.coverage.test.js.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js'); // manual mock — helpers pulls in db transitively

const { buildLlmJsonError, buildProfileInsertParams } = await import('./helpers.js');

describe('buildLlmJsonError', () => {
  const tooLarge = (t) => `too big at ${t}`;

  it('flags truncation when the text has no closing brace', () => {
    const out = buildLlmJsonError({ text: '{ "a": 1 no closing brace here really', usage: { outputTokens: 100 } }, tooLarge);
    expect(out.truncated).toBe(true);
    expect(out.error).toBe('too big at 100');
    expect(out.outputTokens).toBe(100);
  });

  it('flags truncation when output tokens hit the cap', () => {
    const out = buildLlmJsonError({ text: 'garbage}', usage: { outputTokens: 8000 } }, tooLarge);
    expect(out.truncated).toBe(true);
  });

  it('reports a generic malformed error when not truncated', () => {
    const out = buildLlmJsonError({ text: 'a well formed but short }', usage: { outputTokens: 50 } }, tooLarge);
    expect(out.truncated).toBe(false);
    expect(out.error).toMatch(/malformed JSON/);
    expect(out.outputTokens).toBe(50);
  });
});

describe('buildProfileInsertParams', () => {
  it('maps profile fields with null fallbacks and stringifies JSON', () => {
    const params = buildProfileInsertParams({
      displayName: 'Acme', profile: { domain: 'acme.com', industry: 'Tech' },
      transcript: [{ role: 'user' }], sources: null,
      llmCfg: { provider: 'anthropic', model: 'x' }, version: 2, makeActive: 1, createdBy: 'me',
    });
    expect(params[0]).toBe('Acme');
    expect(params[1]).toBe('acme.com');       // profile.domain
    expect(params[3]).toBeNull();             // profile.country missing
    expect(params[4]).toBe(JSON.stringify({ domain: 'acme.com', industry: 'Tech' }));
    expect(params[6]).toBeNull();             // sources null → null (not "null" string)
    expect(params[7]).toBe('anthropic');
    expect(params[9]).toBe(2);                // version
    expect(params[10]).toBe(true);            // !!makeActive
  });
});
