// `<NAME>_FILE` support for secret environment variables (SEC-2026-09 I-04).
//
// Plain environment variables are visible to anyone who can inspect the
// container (`docker inspect`, /proc/<pid>/environ). Docker / Compose `secrets:`
// instead mount the value as a file under /run/secrets. This module lets every
// secret the API reads from the environment be supplied either way:
//
//   POSTGRES_PASSWORD=…                                  (plain env — still works)
//   POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password (file — preferred)
//
// The plain variable always wins when it is set to a non-empty value, so an
// existing deployment keeps behaving exactly as before. When only the `_FILE`
// variant is set, the file is read once at startup and its content (trailing
// newline stripped — `echo value > file` is the common way to create one) is
// copied into the plain variable, so every existing consumer (db/connection.js,
// secrets/vault.js, cli/auth-config.js) picks it up unchanged.

import { readFileSync } from 'fs';

// The secrets the API reads from its environment.
export const FILE_SECRET_NAMES = Object.freeze([
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'IDENTITY_ATLAS_MASTER_KEY',
]);

// Resolve `<name>_FILE` into `<name>` for each name. Returns the names that were
// loaded from a file (never their values). Throws when a `_FILE` variable points
// at a file that cannot be read — starting with a silently empty password or
// master key would be worse than failing loudly.
export function applyFileSecrets(env = process.env, { names = FILE_SECRET_NAMES, readFile = readFileSync } = {}) {
  const loaded = [];
  for (const name of names) {
    const filePath = env[`${name}_FILE`];
    if (!filePath || env[name]) continue;
    let value;
    try {
      value = readFile(filePath, 'utf8');
    } catch (err) {
      throw new Error(`${name}_FILE is set but ${filePath} could not be read: ${err.code || err.message}`);
    }
    value = value.replace(/\r?\n$/, '');
    if (!value) throw new Error(`${name}_FILE points at an empty file (${filePath})`);
    env[name] = value;
    loaded.push(name);
  }
  return loaded;
}
