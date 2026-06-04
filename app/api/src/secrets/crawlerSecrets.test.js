// Unit tests for the crawler clientSecret vault helpers (H-02 part 2).
// The vault is mocked with an in-memory store so we test the helper logic
// (key scoping + claim-time injection) without real encryption/DB.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ store: new Map() }));
vi.mock('./vault.js', () => ({
  putSecret: async (id, _scope, plaintext) => { h.store.set(id, plaintext); },
  getSecret: async (id) => (h.store.has(id) ? h.store.get(id) : null),
  hasSecret: async (id) => h.store.has(id),
  deleteSecret: async (id) => { h.store.delete(id); },
}));

const cs = await import('./crawlerSecrets.js');

beforeEach(() => h.store.clear());

describe('crawlerSecrets — config-scoped secrets', () => {
  it('store / has / get / delete round-trip', async () => {
    expect(await cs.hasConfigSecret(5)).toBe(false);
    await cs.storeConfigSecret(5, 'topsecret');
    expect(await cs.hasConfigSecret(5)).toBe(true);
    expect(await cs.getConfigSecret(5)).toBe('topsecret');
    await cs.deleteConfigSecret(5);
    expect(await cs.hasConfigSecret(5)).toBe(false);
  });
});

describe('crawlerSecrets — injectJobSecret', () => {
  it('pulls the secret from the source config for a config-based job', async () => {
    await cs.storeConfigSecret(7, 'cfg-secret');
    const cfg = await cs.injectJobSecret({ id: 99, config: { tenantId: 't', _scheduledByConfigId: 7 } });
    expect(cfg.clientSecret).toBe('cfg-secret');
    expect(cfg.tenantId).toBe('t');
  });

  it('falls back to a job-scoped secret for an inline job', async () => {
    await cs.storeJobSecret(42, 'job-secret');
    const cfg = await cs.injectJobSecret({ id: 42, config: { tenantId: 't' } });
    expect(cfg.clientSecret).toBe('job-secret');
  });

  it('leaves the config unchanged when no secret exists', async () => {
    const cfg = await cs.injectJobSecret({ id: 1, config: { tenantId: 't' } });
    expect(cfg.clientSecret).toBeUndefined();
  });

  it('parses a stringified job config', async () => {
    await cs.storeConfigSecret(3, 'sss');
    const cfg = await cs.injectJobSecret({ id: 2, config: JSON.stringify({ _scheduledByConfigId: 3 }) });
    expect(cfg.clientSecret).toBe('sss');
  });
});
