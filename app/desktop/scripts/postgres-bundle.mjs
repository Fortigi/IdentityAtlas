// Embeds PostgreSQL server binaries into the portable package (build flag
// --with-postgres on build-node-launcher.mjs). The launcher finds them in
// postgres\ next to Start-IdentityAtlas.ps1 and runs a real server instead of
// PGlite; see docs/architecture/desktop-portable.md.
//
// Source: EDB's official Windows "binaries" zip — the plain archive the
// PostgreSQL project links to for running without an installer. The major
// version matches the Docker image (postgres:16-alpine).
//
// NOT Authenticode-signed. Checked for 16.15, 17.8 and 18.4: postgres.exe,
// initdb.exe, pg_ctl.exe, libpq.dll and every other server binary report
// NotSigned (EDB signs only stackbuilder.exe). A WDAC / AppLocker policy that
// admits node.exe by its OpenJS Foundation publisher will not admit these; the
// machine needs a hash or path rule for them. The launcher detects a refusal and
// falls back to PGlite on a fresh install.

import { readdirSync, statSync, mkdirSync, copyFileSync } from 'fs';
import { join, relative, dirname } from 'path';

export const PG_VERSION = '16.15';
export const PG_URL     = `https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-1-windows-x64-binaries.zip`;
// EDB publishes no checksum list for these archives; this is the SHA-256 of the
// zip as downloaded when the version was pinned (2026-09-26). Update the two together.
export const PG_SHA256  = '25e6fcdfb8caec38691bf461125e7564508760666f7b8e5dc6a5f0818f58f81e';

// The executables the launcher runs, plus pg_dump / pg_restore for backups.
const SHIPPED_EXES = new Set(['postgres.exe', 'pg_ctl.exe', 'initdb.exe', 'psql.exe', 'pg_isready.exe', 'pg_dump.exe', 'pg_restore.exe']);

// Which files of the extracted pgsql\ folder go into the package, by their path
// relative to it (forward slashes). Everything else — pgAdmin (~720 MB),
// StackBuilder, headers, docs, import libraries, message translations and the
// other client tools — is left out.
export function shouldShip(rel) {
  const p = rel.replace(/\\/g, '/');
  const [top, ...rest] = p.split('/');
  const name = rest[rest.length - 1] || '';
  if (top === 'bin' && rest.length === 1) {
    if (name.endsWith('.exe')) return SHIPPED_EXES.has(name);
    // wx* is StackBuilder's GUI toolkit; testplug.dll is a test fixture.
    return name.endsWith('.dll') && !name.startsWith('wx') && name !== 'testplug.dll';
  }
  if (top === 'lib') return rest.length === 1 && name.endsWith('.dll');   // server extension modules
  if (top === 'share') return rest[0] !== 'locale';                        // catalog, timezones, extensions
  return p === 'server_license.txt';
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

// Copies the shipped subset of an extracted pgsql\ folder into destDir.
// Returns { files, bytes } so the build can report what it added.
export function stagePostgres(pgsqlDir, destDir) {
  let files = 0, bytes = 0;
  for (const full of walk(pgsqlDir)) {
    const rel = relative(pgsqlDir, full);
    if (!shouldShip(rel)) continue;
    const out = join(destDir, rel);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(full, out);
    files++; bytes += statSync(full).size;
  }
  return { files, bytes };
}

