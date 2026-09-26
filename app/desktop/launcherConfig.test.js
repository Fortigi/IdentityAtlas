// Unit tests for the portable launcher's pure helpers (node-launcher/launcherConfig.mjs).
// Run by the API Vitest suite (app/api/vitest.config.js includes this folder).
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  resolveDataDir, selectDatabase, apiEnv, formatCrashReport, installCrashLog, runCli, CRASH_LOG_NAME,
} from './node-launcher/launcherConfig.mjs';

const HOME = join('C:', 'Users', 'u');

describe('resolveDataDir', () => {
  const none = () => false;

  it('an explicit IA_DATA_DIR wins even when Roaming holds data', () => {
    expect(resolveDataDir({ IA_DATA_DIR: 'D:\\ia', APPDATA: 'R' }, { home: HOME, exists: () => true })).toBe('D:\\ia');
  });

  it('stays in Roaming when an existing install keeps its pgdata there', () => {
    const exists = p => p === join('R', 'IdentityAtlas', 'pgdata');
    expect(resolveDataDir({ APPDATA: 'R', LOCALAPPDATA: 'L' }, { home: HOME, exists })).toBe(join('R', 'IdentityAtlas'));
  });

  it('uses LOCALAPPDATA for a fresh install', () => {
    expect(resolveDataDir({ APPDATA: 'R', LOCALAPPDATA: 'L' }, { home: HOME, exists: none })).toBe(join('L', 'IdentityAtlas'));
  });

  it('falls back to the profile folders when the env vars are missing', () => {
    const seen = [];
    const exists = p => { seen.push(p); return false; };
    expect(resolveDataDir({}, { home: HOME, exists })).toBe(join(HOME, 'AppData', 'Local', 'IdentityAtlas'));
    expect(seen).toEqual([join(HOME, 'AppData', 'Roaming', 'IdentityAtlas', 'pgdata')]);
  });
});

describe('selectDatabase', () => {
  it('uses PGlite when no server is configured', () => {
    expect(selectDatabase({})).toEqual({ external: false, label: 'built-in PGlite' });
  });

  it('never puts DATABASE_URL (which carries the password) in the label', () => {
    const db = selectDatabase({ DATABASE_URL: 'postgresql://ia:S3CRET-PW@127.0.0.1:5433/ia', POSTGRES_HOST: 'h' });
    expect(db.external).toBe(true);
    expect(db.label).not.toContain('S3CRET-PW');
    expect(db.label).toBe('external PostgreSQL (DATABASE_URL)');
  });

  it('names host and port for POSTGRES_HOST, and omits a missing port', () => {
    expect(selectDatabase({ POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: '5433', POSTGRES_PASSWORD: 'PW-9' }))
      .toEqual({ external: true, label: 'external PostgreSQL (127.0.0.1:5433)' });
    expect(selectDatabase({ POSTGRES_HOST: 'db' }).label).toBe('external PostgreSQL (db)');
  });
});

describe('apiEnv', () => {
  const base = { dataDir: 'D', appDir: 'A', port: 3007 };

  it('sets DESKTOP_MODE only for PGlite', () => {
    expect(apiEnv({ ...base, env: {}, external: false }).DESKTOP_MODE).toBe('true');
    expect(apiEnv({ ...base, env: {}, external: true })).not.toHaveProperty('DESKTOP_MODE');
  });

  // Regression guard: index.js binds 0.0.0.0 when DESKTOP_MODE is off unless HOST
  // says otherwise, so the real-PostgreSQL mode must pin loopback itself — and
  // must not let an inherited HOST widen it.
  it('pins the API to loopback in both modes, overriding an inherited HOST', () => {
    for (const external of [true, false]) {
      expect(apiEnv({ ...base, env: { HOST: '0.0.0.0' }, external }).HOST).toBe('127.0.0.1');
    }
  });

  it('places keys, uploads and traces in the data dir and app assets in the app dir', () => {
    const e = apiEnv({ ...base, env: {}, external: true });
    expect(e).toMatchObject({
      USE_SQL: 'true', PORT: '3007', NODE_ENV: 'production',
      WORKER_KEY_FILE: join('D', '.builtin-worker-key'), MASTER_KEY_FILE: join('D', '.master-key'),
      UPLOAD_ROOT: join('D', 'uploads'), TRACE_DIR: join('D', 'jobs'),
      FRONTEND_DIST: join('A', 'dist-frontend'), IA_APP_ROOT: join('A', 'bundled-scripts'),
      CRAWLER_MANIFESTS_DIR: join('A', 'bundled-scripts', 'tools', 'crawlers'),
    });
  });

  it('keeps an explicit NODE_ENV', () => {
    expect(apiEnv({ ...base, env: { NODE_ENV: 'development' }, external: false }).NODE_ENV).toBe('development');
  });
});

describe('formatCrashReport', () => {
  const now = new Date('2026-09-26T10:11:12.000Z');

  it('records time, kind, runtime, database and the stack', () => {
    const err = new Error('boom-41');
    const text = formatCrashReport('uncaughtException', err, { now, database: 'built-in PGlite', nodeVersion: 'v24.0.0' });
    expect(text.split('\n').slice(0, 2)).toEqual([
      '=== 2026-09-26T10:11:12.000Z uncaughtException ===',
      'node v24.0.0, database: built-in PGlite',
    ]);
    expect(text).toContain(err.stack);
  });

  it('handles a non-Error rejection and an Error without a stack', () => {
    expect(formatCrashReport('unhandledRejection', 'plain-42', { now, nodeVersion: 'v1' }))
      .toBe('=== 2026-09-26T10:11:12.000Z unhandledRejection ===\nnode v1\nplain-42\n');
    const bare = new Error('msg-43'); bare.stack = '';
    expect(formatCrashReport('x', bare, { now, nodeVersion: 'v1' })).toContain('\nmsg-43\n');
  });
});

describe('installCrashLog', () => {
  function fakeProcess() {
    const p = new EventEmitter();
    p.version = 'v24.9.9';
    p.exit = vi.fn();
    return p;
  }

  it.each(['uncaughtException', 'unhandledRejection'])('writes %s to the data dir and exits 1', (kind) => {
    const proc = fakeProcess();
    const append = vi.fn();
    const log = vi.fn();
    const file = installCrashLog(proc, 'D', { database: 'lbl', append, log });
    expect(file).toBe(join('D', CRASH_LOG_NAME));

    proc.emit(kind, new Error('fail-44'));

    expect(append).toHaveBeenCalledTimes(1);
    const [path, text] = append.mock.calls[0];
    expect(path).toBe(file);
    expect(text).toContain(`${kind} ===`);
    expect(text).toContain('node v24.9.9, database: lbl');
    expect(text).toContain('fail-44');
    expect(log).toHaveBeenCalledWith(expect.stringContaining(file));
    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it('still exits 1 when the log file cannot be written', () => {
    const proc = fakeProcess();
    const log = vi.fn();
    installCrashLog(proc, 'D', { append: () => { throw new Error('EACCES'); }, log });
    const err = new Error('fail-45');
    proc.emit('uncaughtException', err);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(err);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });
});

describe('runCli', () => {
  it('prints the resolved data dir for --print-data-dir', () => {
    const write = vi.fn();
    expect(runCli(['--print-data-dir'], { IA_DATA_DIR: 'X:\\d' }, write)).toBe(0);
    expect(write).toHaveBeenCalledWith('X:\\d\n');
  });

  it('refuses anything else without printing', () => {
    const write = vi.fn();
    expect(runCli([], {}, write)).toBe(2);
    expect(write).not.toHaveBeenCalled();
  });
});
