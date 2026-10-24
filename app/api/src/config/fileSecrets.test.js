// <NAME>_FILE secret loading (SEC-2026-09 I-04).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyFileSecrets, FILE_SECRET_NAMES } from './fileSecrets.js';

const dir = mkdtempSync(join(tmpdir(), 'iasecret-'));
const secretFile = (name, content) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

describe('applyFileSecrets', () => {
  it('covers the database password, connection string and vault master key', () => {
    expect([...FILE_SECRET_NAMES].sort()).toEqual(['DATABASE_URL', 'IDENTITY_ATLAS_MASTER_KEY', 'POSTGRES_PASSWORD']);
  });

  it('loads the value from the file and strips exactly one trailing newline', () => {
    const env = {
      POSTGRES_PASSWORD_FILE: secretFile('pg', 'p@ss word\n'),
      IDENTITY_ATLAS_MASTER_KEY_FILE: secretFile('mk', 'line1\nline2\r\n'),
    };
    expect(applyFileSecrets(env)).toEqual(['POSTGRES_PASSWORD', 'IDENTITY_ATLAS_MASTER_KEY']);
    expect(env.POSTGRES_PASSWORD).toBe('p@ss word');
    expect(env.IDENTITY_ATLAS_MASTER_KEY).toBe('line1\nline2');
  });

  it('keeps leading/trailing spaces inside the value (a password may contain them)', () => {
    const env = { POSTGRES_PASSWORD_FILE: secretFile('sp', ' x ') };
    applyFileSecrets(env);
    expect(env.POSTGRES_PASSWORD).toBe(' x ');
  });

  it('a plain variable that is already set wins, so existing deployments are unchanged', () => {
    const env = { POSTGRES_PASSWORD: 'from-env', POSTGRES_PASSWORD_FILE: secretFile('pg2', 'from-file') };
    expect(applyFileSecrets(env)).toEqual([]);
    expect(env.POSTGRES_PASSWORD).toBe('from-env');
  });

  it('an empty plain variable (compose `${VAR:-}`) does not shadow the file', () => {
    const env = { IDENTITY_ATLAS_MASTER_KEY: '', IDENTITY_ATLAS_MASTER_KEY_FILE: secretFile('mk2', 'k') };
    expect(applyFileSecrets(env)).toEqual(['IDENTITY_ATLAS_MASTER_KEY']);
    expect(env.IDENTITY_ATLAS_MASTER_KEY).toBe('k');
  });

  it('ignores names outside the list', () => {
    const env = { OTHER_FILE: secretFile('o', 'v') };
    expect(applyFileSecrets(env)).toEqual([]);
    expect(env.OTHER).toBeUndefined();
  });

  it('fails loudly, naming the variable but not a value, when the file is missing', () => {
    const env = { POSTGRES_PASSWORD_FILE: join(dir, 'missing') };
    expect(() => applyFileSecrets(env)).toThrow(/^POSTGRES_PASSWORD_FILE is set but .*missing could not be read: ENOENT$/);
    expect(env.POSTGRES_PASSWORD).toBeUndefined();
  });

  it('falls back to the error message when the read error has no code', () => {
    const readFile = () => { throw new Error('boom'); };
    expect(() => applyFileSecrets({ DATABASE_URL_FILE: '/x' }, { readFile })).toThrow(/could not be read: boom$/);
  });

  it('refuses an empty secret file', () => {
    const env = { DATABASE_URL_FILE: secretFile('empty', '\n') };
    expect(() => applyFileSecrets(env)).toThrow(/DATABASE_URL_FILE points at an empty file/);
  });
});

describe('loadFileSecrets (entry-point side effect)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    vi.restoreAllMocks();
  });

  it('populates process.env on import and logs only the variable names', async () => {
    delete process.env.POSTGRES_PASSWORD;
    process.env.POSTGRES_PASSWORD_FILE = secretFile('side', 'side-effect-secret\n');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.resetModules();
    await import('./loadFileSecrets.js');
    expect(process.env.POSTGRES_PASSWORD).toBe('side-effect-secret');
    expect(logSpy).toHaveBeenCalledWith('Secrets loaded from files: POSTGRES_PASSWORD');
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('side-effect-secret');
  });
});
