// Unit tests for the startup plaintext->vault migration of crawler credentials
// (H-02 part 2, SEC-2026-09 M-10). db + crawlerSecrets are mocked so we assert
// which rows get vaulted vs merely stripped, and that it's idempotent.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ store: new Map(), stripped: [], configRows: [], jobRows: [], failOn: null }));

vi.mock('../db/connection.js', () => ({
  query: async (sql, params = []) => {
    const s = String(sql);
    if (h.failOn && h.failOn.test(s)) throw new Error('db down');
    if (/SELECT[\s\S]*FROM "CrawlerConfigs"/i.test(s)) return { rows: h.configRows, rowCount: h.configRows.length };
    if (/SELECT[\s\S]*FROM "CrawlerJobs"/i.test(s)) return { rows: h.jobRows, rowCount: h.jobRows.length };
    if (/UPDATE "CrawlerConfigs"/i.test(s)) { h.stripped.push(['config', params[0], params[1]]); return { rowCount: 1 }; }
    if (/UPDATE "CrawlerJobs"/i.test(s)) { h.stripped.push(['job', params[0], params[1]]); return { rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  },
}));
vi.mock('./crawlerSecrets.js', () => ({
  CONFIG_SECRET_FIELDS: ['clientSecret', 'password', 'apiToken', 'cookieString'],
  storeConfigFields: async (id, values) => { for (const [f, v] of Object.entries(values)) h.store.set(`config:${id}:${f}`, v); },
  storeJobSecret: async (id, sec) => { h.store.set(`job:${id}`, sec); },
  storeJobCredentials: async (id, creds) => { if (Object.keys(creds).length) h.store.set(`jobcreds:${id}`, creds); },
}));

const { migrateCrawlerSecretsToVault } = await import('./migrateCrawlerSecrets.js');

const ALL = ['clientSecret', 'password', 'apiToken', 'cookieString'];

beforeEach(() => { h.store.clear(); h.stripped = []; h.configRows = []; h.jobRows = []; h.failOn = null; });

describe('migrateCrawlerSecretsToVault', () => {
  it('vaults config + inline-job secrets and strips all plaintext', async () => {
    h.configRows = [{ id: 5, config: { clientSecret: 'cfgsec', tenantId: 't' } }];
    h.jobRows = [
      { id: 9, config: { clientSecret: 'jobsec' }, configId: null },   // inline job → vault by job id
      { id: 10, config: { clientSecret: 'fromcfg' }, configId: 5 },    // config-derived → just strip
    ];

    await migrateCrawlerSecretsToVault();

    expect(h.store.get('config:5:clientSecret')).toBe('cfgsec');
    expect(h.store.get('job:9')).toBe('jobsec');
    expect(h.store.has('job:10')).toBe(false);
    expect(h.stripped).toEqual([['config', 5, ALL], ['job', 9, ALL], ['job', 10, ALL]]);
  });

  // SEC-2026-09 M-10
  it('vaults plaintext password / apiToken / cookieString per config', async () => {
    h.configRows = [{ id: 7, config: { baseUrl: 'https://o', password: 'pw', apiToken: 'tok', cookieString: '' } }];
    await migrateCrawlerSecretsToVault();
    expect(Object.fromEntries(h.store)).toEqual({ 'config:7:password': 'pw', 'config:7:apiToken': 'tok' });
    expect(h.stripped).toEqual([['config', 7, ALL]]);
  });

  it('bundles an inline job\'s other credential fields per job, but not a config-derived job\'s', async () => {
    h.jobRows = [
      { id: 11, config: { password: 'pw', apiToken: 'tok' }, configId: null },
      { id: 12, config: { password: 'pw' }, configId: 3 },
    ];
    await migrateCrawlerSecretsToVault();
    expect(h.store.get('jobcreds:11')).toEqual({ password: 'pw', apiToken: 'tok' });
    expect(h.store.has('job:11')).toBe(false);
    expect(h.store.has('jobcreds:12')).toBe(false);
    expect(h.stripped.map(s => s[1])).toEqual([11, 12]);
  });

  it('is idempotent — no plaintext rows means no writes', async () => {
    await migrateCrawlerSecretsToVault();
    expect(h.store.size).toBe(0);
    expect(h.stripped).toEqual([]);
  });

  it('a config-table failure does not stop the job pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.failOn = /FROM "CrawlerConfigs"/;
    h.jobRows = [{ id: 13, config: { clientSecret: 's' }, configId: null }];
    await migrateCrawlerSecretsToVault();
    expect(h.store.get('job:13')).toBe('s');
    expect(warn).toHaveBeenCalledWith('Crawler-config secret migration skipped:', 'db down');
    warn.mockRestore();
  });
});
