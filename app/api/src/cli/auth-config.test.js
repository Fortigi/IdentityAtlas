// Unit tests for cli/auth-config.js — the auth-config CLI. pg is mocked so no DB
// is touched; process.exit is trapped so command-dispatch branches are testable.
// (#666: 0 floor.)

process.env.USE_SQL = 'true'; // module-load guard exits the process otherwise

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockClient, mockQuery } = vi.hoisted(() => {
  const q = vi.fn();
  return { mockQuery: q, mockClient: { connect: vi.fn(), end: vi.fn(), query: q } };
});
// Plain function (not an arrow) so `new pg.Client()` is a valid constructor;
// returning an object makes `new` yield that object.
vi.mock('pg', () => ({ default: { Client: function Client() { return mockClient; } } }));

const {
  parseArgs, buildPgConfig, readSettings, upsert, printStatus, usage, main,
} = await import('./auth-config.js');

const GUID = '10b6a2c8-41f9-400d-8020-4ca96606899f';

class Exit extends Error { constructor(code) { super('exit'); this.code = code; } }
let exitSpy, logSpy, errSpy, argv, env;

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  mockClient.connect.mockClear();
  mockClient.end.mockClear();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((c) => { throw new Exit(c); });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  argv = process.argv;
  env = { ...process.env };
});
afterEach(() => {
  exitSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore();
  process.argv = argv;
  process.env = env;
});

describe('parseArgs', () => {
  it('parses flags with values, boolean flags, and positionals', () => {
    expect(parseArgs(['enable', '--tenant', GUID, '--roles', 'a,b'])).toEqual({ _: ['enable'], tenant: GUID, roles: 'a,b' });
    expect(parseArgs(['--disable'])).toEqual({ _: [], disable: true });     // no following value → true
    expect(parseArgs(['--a', '--b', 'x'])).toEqual({ _: [], a: true, b: 'x' }); // --a's "value" is another flag
  });
});

describe('buildPgConfig', () => {
  it('uses DATABASE_URL when set', () => {
    process.env.DATABASE_URL = 'postgres://u:p@h/db';
    expect(buildPgConfig()).toEqual({ connectionString: 'postgres://u:p@h/db' });
  });
  it('falls back to discrete POSTGRES_* vars with defaults', () => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_HOST;
    const cfg = buildPgConfig();
    expect(cfg.host).toBe('postgres');
    expect(cfg.port).toBe(5432);
    expect(cfg.database).toBe('identity_atlas');
  });
});

describe('readSettings', () => {
  it('maps WorkerConfig rows into a settings object', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { configKey: 'AUTH_ENABLED', configValue: 'true' },
      { configKey: 'AUTH_TENANT_ID', configValue: 't' },
      { configKey: 'AUTH_REQUIRED_ROLES', configValue: 'r1, r2' },
    ] });
    const s = await readSettings(mockClient);
    expect(s).toEqual({ enabled: true, tenantId: 't', clientId: '', requiredRoles: ['r1', 'r2'] });
  });
});

describe('upsert', () => {
  it('runs an INSERT … ON CONFLICT with the key/value', async () => {
    await upsert(mockClient, 'AUTH_ENABLED', 'true');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO "WorkerConfig"');
    expect(sql).toContain('ON CONFLICT');
    expect(params).toEqual(['AUTH_ENABLED', 'true']);
  });
});

describe('printStatus / usage', () => {
  it('printStatus prints the values', () => {
    printStatus({ enabled: true, tenantId: 't', clientId: 'c', requiredRoles: ['x'] });
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('ENABLED');
    expect(out).toContain('t');
    expect(out).toContain('x');
  });
  it('usage prints help text', () => {
    usage();
    expect(logSpy.mock.calls.join('\n')).toContain('Auth Config CLI');
  });
});

describe('main dispatch', () => {
  const run = (...cmd) => { process.argv = ['node', 'auth-config.js', ...cmd]; return main(); };

  it('help / no command exits 0', async () => {
    await expect(run()).rejects.toBeInstanceOf(Exit);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
  it('status reads + prints settings', async () => {
    await run('status');
    expect(mockClient.connect).toHaveBeenCalled();
    expect(logSpy.mock.calls.join('\n')).toContain('Authentication Settings');
  });
  it('enable requires a valid tenant GUID', async () => {
    await expect(run('enable')).rejects.toBeInstanceOf(Exit);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
  it('enable with valid GUIDs upserts the four keys', async () => {
    await run('enable', '--tenant', GUID, '--client', GUID);
    // 4 upserts + 1 readSettings SELECT.
    expect(mockQuery).toHaveBeenCalledTimes(5);
  });
  it('disable turns auth off', async () => {
    await run('disable');
    expect(mockQuery.mock.calls[0][1]).toEqual(['AUTH_ENABLED', 'false']);
  });
  it('unknown command exits 1', async () => {
    await expect(run('bogus')).rejects.toBeInstanceOf(Exit);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
