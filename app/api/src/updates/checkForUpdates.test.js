// Unit tests for updates/checkForUpdates.js — orchestrates one update check and
// writes to UpdateLog. db + the channel/detect deps are mocked; isNewer is real.
// (#666: 0 floor.)

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('./channel.js', () => ({ resolveChannel: vi.fn(), getCurrentVersion: vi.fn() }));
vi.mock('./detect.js', () => ({ getLatestForChannel: vi.fn() }));

import * as db from '../db/connection.js';
import { resolveChannel, getCurrentVersion } from './channel.js';
import { getLatestForChannel } from './detect.js';
import { recordLog, runUpdateCheck } from './checkForUpdates.js';

beforeEach(() => {
  vi.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
  resolveChannel.mockReturnValue('stable');
  getCurrentVersion.mockReturnValue('5.1.0');
});

describe('recordLog', () => {
  it('inserts a normalised UpdateLog row', async () => {
    const client = { query: vi.fn().mockResolvedValue({}) };
    await recordLog({ channel: 'stable', currentVersion: '5.1.0', latestVersion: '5.2.0', updateAvailable: true, status: 'available' }, client);
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO "UpdateLog"');
    expect(params).toEqual(['stable', '5.1.0', '5.2.0', true, 'available', null, null]);
  });
});

describe('runUpdateCheck', () => {
  it('reports an available update when the latest is newer', async () => {
    getLatestForChannel.mockResolvedValue('5.2.0');
    const r = await runUpdateCheck({ source: 'test' });
    expect(r).toMatchObject({ channel: 'stable', latestVersion: '5.2.0', updateAvailable: true, status: 'available' });
    // Final recordLog INSERT carries the result.
    const insert = db.query.mock.calls.find(c => /INSERT INTO "UpdateLog"/.test(c[0]) && c[1][4] === 'available');
    expect(insert).toBeDefined();
  });

  it('reports up-to-date when the latest is not newer', async () => {
    getLatestForChannel.mockResolvedValue('5.1.0');
    const r = await runUpdateCheck();
    expect(r.status).toBe('up-to-date');
    expect(r.updateAvailable).toBe(false);
  });

  it('reports "checked" with a channel-specific detail when there is no latest', async () => {
    getLatestForChannel.mockResolvedValue(null);
    expect((await runUpdateCheck()).detail).toContain('No version information');
    resolveChannel.mockReturnValue('pinned');
    expect((await runUpdateCheck()).detail).toContain('Pinned');
  });

  it('reports failed with the error message when the lookup throws', async () => {
    getLatestForChannel.mockRejectedValue(new Error('github down'));
    const r = await runUpdateCheck();
    expect(r.status).toBe('failed');
    expect(r.detail).toBe('github down');
  });

  it('logs an "installed" row when the running version changed since last check', async () => {
    // detectInstalled's SELECT returns a different previous version.
    db.query.mockResolvedValueOnce({ rows: [{ currentVersion: '5.0.0' }] });
    getLatestForChannel.mockResolvedValue('5.1.0');
    await runUpdateCheck();
    const installed = db.query.mock.calls.find(c => Array.isArray(c[1]) && c[1][4] === 'installed');
    expect(installed).toBeDefined();
    expect(installed[1]).toEqual(expect.arrayContaining(['5.0.0', '5.1.0']));
  });
});
