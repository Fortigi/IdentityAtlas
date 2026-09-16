// Unit tests for the crawler credential vault helpers.
// The vault is mocked with an in-memory store that honours scope, so we test
// the helper logic (key layout, scope, claim-time injection) without real
// encryption or a DB.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ store: new Map() }));
vi.mock('./vault.js', () => {
  const get = (id, scope) => { const e = h.store.get(id); return e && e.scope === scope ? e : null; };
  return {
    putSecret: async (id, scope, plaintext) => { h.store.set(id, { scope, value: plaintext }); },
    getSecret: async (id, scope) => get(id, scope)?.value ?? null,
    hasSecret: async (id, scope) => !!get(id, scope),
    existingSecretIds: async (ids, scope) => new Set(ids.filter(id => get(id, scope))),
    deleteSecret: async (id, scope) => (get(id, scope) ? h.store.delete(id) : false),
  };
});

const cs = await import('./crawlerSecrets.js');

beforeEach(() => h.store.clear());

describe('crawlerSecrets — per-config credentials', () => {
  it('clientSecret store / has / get round-trip in the crawler-config scope', async () => {
    expect(await cs.hasConfigSecret(5)).toBe(false);
    await cs.storeConfigSecret(5, 'topsecret');
    expect(h.store.get('crawler-config:5:clientSecret')).toEqual({ scope: 'crawler-config', value: 'topsecret' });
    expect(await cs.hasConfigSecret(5)).toBe(true);
    expect(await cs.getConfigSecret(5)).toBe('topsecret');
  });

  // SEC-2026-09 M-10: the other credential fields are vaulted per config too.
  it('vaults each non-empty credential field under its own key', async () => {
    await cs.storeConfigFields(8, { password: 'pw', apiToken: '', cookieString: 'ck' });
    expect([...h.store.keys()].sort()).toEqual(['crawler-config:8:cookieString', 'crawler-config:8:password']);
    expect(await cs.vaultedConfigFields(8)).toEqual(['password', 'cookieString']);
    expect(await cs.getConfigCredentials(8)).toEqual({ password: 'pw', cookieString: 'ck' });
  });

  it('refuses a field that is not a credential field', async () => {
    await expect(cs.storeConfigField(8, 'baseUrl', 'https://x')).rejects.toThrow('Not a vaulted crawler credential field');
    expect(h.store.size).toBe(0);
  });

  it('storeConfigFields tolerates no values', async () => {
    await cs.storeConfigFields(8, undefined);
    expect(h.store.size).toBe(0);
  });

  it('deleteConfigSecrets removes every field of that config only', async () => {
    await cs.storeConfigFields(1, { clientSecret: 'a', password: 'b', apiToken: 'c', cookieString: 'd' });
    await cs.storeConfigSecret(2, 'other');
    await cs.deleteConfigSecrets(1);
    expect([...h.store.keys()]).toEqual(['crawler-config:2:clientSecret']);
  });

  it('a credential stored in another scope under a config key is not reported', async () => {
    h.store.set('crawler-config:9:password', { scope: 'scraper', value: 'x' });
    expect(await cs.vaultedConfigFields(9)).toEqual([]);
    expect(await cs.getConfigCredentials(9)).toEqual({});
  });
});

describe('crawlerSecrets — per-job credentials', () => {
  it('deleteJobSecrets removes the job clientSecret and the credentials bundle', async () => {
    await cs.storeJobSecret(4, 's');
    await cs.storeJobCredentials(4, { password: 'p' });
    await cs.storeJobSecret(5, 'keep');
    await cs.deleteJobSecrets(4);
    expect([...h.store.keys()]).toEqual(['crawler-job:5:clientSecret']);
  });

  it('storeJobCredentials writes nothing when no field is set', async () => {
    await cs.storeJobCredentials(4, { password: '' });
    expect(h.store.size).toBe(0);
  });
});

describe('crawlerSecrets — injectJobSecret', () => {
  it('injects the source config credentials for a job whose configId column is set', async () => {
    await cs.storeConfigFields(7, { clientSecret: 'cfg-secret', password: 'cfg-pw' });
    const cfg = await cs.injectJobSecret({ id: 99, configId: 7, config: { tenantId: 't', _scheduledByConfigId: 7 } });
    expect(cfg).toEqual({ tenantId: 't', clientSecret: 'cfg-secret', password: 'cfg-pw', _scheduledByConfigId: 7 });
  });

  // SEC-2026-09 H-02: which config's credentials a job gets is decided by the
  // column, never by the job's own JSON.
  it('an inline job naming another config in its JSON never receives that config\'s secret', async () => {
    await cs.storeConfigSecret(3, 'entra-client-secret');
    await cs.storeJobSecret(50, 'dummy');
    const cfg = await cs.injectJobSecret({ id: 50, configId: null, config: { baseUrl: 'https://x', _scheduledByConfigId: 3 } });
    expect(cfg.clientSecret).toBe('dummy');
    expect(cfg).not.toHaveProperty('_scheduledByConfigId');
  });

  it('an inline job with no secret of its own gets none, whatever its JSON says', async () => {
    await cs.storeConfigSecret(3, 'entra-client-secret');
    const cfg = await cs.injectJobSecret({ id: 51, config: JSON.stringify({ _scheduledByConfigId: '3' }) });
    expect(cfg).toEqual({});
  });

  it('uses the column over a conflicting JSON value and rewrites _scheduledByConfigId', async () => {
    await cs.storeConfigSecret(3, 'three');
    await cs.storeConfigSecret(7, 'seven');
    const cfg = await cs.injectJobSecret({ id: 52, configId: 7, config: { _scheduledByConfigId: 3 } });
    expect(cfg).toEqual({ clientSecret: 'seven', _scheduledByConfigId: 7 });
  });

  it.each([[0], [-1], ['abc'], [1.5], [undefined]])('ignores a non-positive-integer configId %j', async (configId) => {
    await cs.storeConfigSecret(1, 'one');
    const cfg = await cs.injectJobSecret({ id: 53, configId, config: {} });
    expect(cfg).toEqual({});
  });

  it('falls back to the job-scoped secret + bundle for an inline job', async () => {
    await cs.storeJobSecret(42, 'job-secret');
    await cs.storeJobCredentials(42, { password: 'pw', apiToken: 'tok' });
    const cfg = await cs.injectJobSecret({ id: 42, config: { tenantId: 't' } });
    expect(cfg).toEqual({ tenantId: 't', clientSecret: 'job-secret', password: 'pw', apiToken: 'tok' });
  });

  it('config credentials win over per-job ones for a config-based job', async () => {
    await cs.storeJobCredentials(60, { password: 'snapshot' });
    await cs.storeJobSecret(60, 'job-secret');
    await cs.storeConfigFields(6, { password: 'current' });
    const cfg = await cs.injectJobSecret({ id: 60, configId: 6, config: {} });
    expect(cfg).toEqual({ clientSecret: 'job-secret', password: 'current', _scheduledByConfigId: 6 });
  });

  it('ignores a malformed bundle and non-credential keys inside a bundle', async () => {
    h.store.set('crawler-job:70:credentials', { scope: 'crawler-job', value: '{not json' });
    expect(await cs.injectJobSecret({ id: 70, config: { a: 1 } })).toEqual({ a: 1 });
    h.store.set('crawler-job:71:credentials', { scope: 'crawler-job', value: JSON.stringify({ baseUrl: 'https://evil', password: 'p' }) });
    expect(await cs.injectJobSecret({ id: 71, config: { baseUrl: 'https://real' } })).toEqual({ baseUrl: 'https://real', password: 'p' });
  });

  it('treats a null config as empty', async () => {
    expect(await cs.injectJobSecret({ id: 1, config: null })).toEqual({});
  });
});
