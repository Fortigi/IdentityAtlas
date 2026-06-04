// Unit tests for the one-time plaintext->vault migration (H-02 part 2).
// db + crawlerSecrets are mocked so we assert which rows get vaulted vs merely
// stripped, and that it's idempotent.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ store: new Map(), stripped: [], configRows: [], jobRows: [] }));

vi.mock('../db/connection.js', () => ({
  query: async (sql, params = []) => {
    const s = String(sql);
    if (/SELECT[\s\S]*FROM "CrawlerConfigs"/i.test(s)) return { rows: h.configRows, rowCount: h.configRows.length };
    if (/SELECT[\s\S]*FROM "CrawlerJobs"/i.test(s)) return { rows: h.jobRows, rowCount: h.jobRows.length };
    if (/UPDATE "CrawlerConfigs"/i.test(s)) { h.stripped.push(['config', params[0]]); return { rowCount: 1 }; }
    if (/UPDATE "CrawlerJobs"/i.test(s)) { h.stripped.push(['job', params[0]]); return { rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  },
}));
vi.mock('./crawlerSecrets.js', () => ({
  storeConfigSecret: async (id, sec) => { h.store.set(`config:${id}`, sec); },
  storeJobSecret: async (id, sec) => { h.store.set(`job:${id}`, sec); },
}));

const { migrateCrawlerSecretsToVault } = await import('./migrateCrawlerSecrets.js');

beforeEach(() => { h.store.clear(); h.stripped = []; h.configRows = []; h.jobRows = []; });

describe('migrateCrawlerSecretsToVault', () => {
  it('vaults config + inline-job secrets and strips all plaintext', async () => {
    h.configRows = [{ id: 5, secret: 'cfgsec' }];
    h.jobRows = [
      { id: 9, secret: 'jobsec', src: null },   // inline job → vault by job id
      { id: 10, secret: 'fromcfg', src: '5' },  // config-derived → just strip
    ];

    await migrateCrawlerSecretsToVault();

    expect(h.store.get('config:5')).toBe('cfgsec');
    expect(h.store.get('job:9')).toBe('jobsec');
    expect(h.store.has('job:10')).toBe(false);
    expect(h.stripped).toEqual(expect.arrayContaining([['config', 5], ['job', 9], ['job', 10]]));
  });

  it('is idempotent — no plaintext rows means no writes', async () => {
    await migrateCrawlerSecretsToVault();
    expect(h.store.size).toBe(0);
    expect(h.stripped).toEqual([]);
  });
});
