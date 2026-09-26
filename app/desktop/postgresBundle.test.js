// Unit tests for the --with-postgres packaging step (scripts/postgres-bundle.mjs).
// Run by the API Vitest suite (app/api/vitest.config.js includes this folder).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldShip, stagePostgres, PG_VERSION, PG_URL, PG_SHA256 } from './scripts/postgres-bundle.mjs';

describe('shouldShip', () => {
  it.each([
    // what the launcher runs, and backups
    'bin/postgres.exe', 'bin/pg_ctl.exe', 'bin/initdb.exe', 'bin/psql.exe', 'bin/pg_isready.exe',
    'bin/pg_dump.exe', 'bin/pg_restore.exe',
    // their DLLs, with Windows separators too
    'bin/libpq.dll', 'bin\\icuuc67.dll', 'bin/zlib1.dll',
    // extension modules and the catalog/timezone/extension data initdb and pg_trgm need
    'lib/pg_trgm.dll', 'share/postgres.bki', 'share/extension/pg_trgm.control', 'share\\timezone\\Europe\\Amsterdam',
    'server_license.txt',
  ])('ships %s', (p) => expect(shouldShip(p)).toBe(true));

  it.each([
    'bin/pgbench.exe', 'bin/stackbuilder.exe', 'bin/pg_upgrade.exe',
    'bin/wxmsw3211u_core_vc_x64_custom.dll', 'bin/testplug.dll',
    'bin/sub/extra.dll',                        // only bin's own files
    'lib/libpq.lib', 'lib/pkgconfig/libpq.pc',  // import libraries, build metadata
    'lib/sub/x.dll',
    'share/locale/nl/LC_MESSAGES/postgres-16.mo',
    'pgAdmin 4/python/python.exe', 'StackBuilder/x.dll', 'include/libpq-fe.h', 'doc/postgresql/html/index.html',
    'pgAdmin_license.txt', 'bin',
  ])('leaves out %s', (p) => expect(shouldShip(p)).toBe(false));
});

describe('stagePostgres', () => {
  it('copies only the shipped subset, keeping the layout, and reports the size', () => {
    const root = mkdtempSync(join(tmpdir(), 'pgb-'));
    try {
      const src = join(root, 'pgsql');
      const files = {
        'bin/postgres.exe': 'abc', 'bin/pgbench.exe': 'zzzz', 'lib/pg_trgm.dll': 'de',
        'share/extension/pg_trgm.control': 'f', 'share/locale/nl/x.mo': 'yyyy', 'doc/readme': 'x',
      };
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(join(src, rel, '..'), { recursive: true });
        writeFileSync(join(src, rel), body);
      }
      const dest = join(root, 'out');
      expect(stagePostgres(src, dest)).toEqual({ files: 3, bytes: 6 });
      expect(existsSync(join(dest, 'bin', 'postgres.exe'))).toBe(true);
      expect(existsSync(join(dest, 'share', 'extension', 'pg_trgm.control'))).toBe(true);
      expect(existsSync(join(dest, 'bin', 'pgbench.exe'))).toBe(false);
      expect(existsSync(join(dest, 'share', 'locale'))).toBe(false);
      expect(existsSync(join(dest, 'doc'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pinned source', () => {
  it('matches the Docker major version and names the pinned archive', () => {
    expect(PG_VERSION).toMatch(/^16\.\d+$/);
    expect(PG_URL).toBe(`https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-1-windows-x64-binaries.zip`);
    expect(PG_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
