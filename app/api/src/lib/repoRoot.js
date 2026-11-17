// The repository root, found by walking UP from this file until the directory that
// holds setup/IdentityAtlas.psd1 — for tests and dev tooling that read files outside
// app/api (docs/, ontology/, tools/crawlers/, app/ui/src).
//
// Why not `join(here, '..', '..', '..', '..')`: that counts directories, so it is
// only right while the file sits exactly that deep in the real checkout. Stryker
// copies app/api into app/api/.stryker-tmp/sandbox-*/ and runs the tests there; a
// counted path then lands on app/api/ and every read of docs/ or tools/ fails the
// dry run, aborting the whole mutation scope before a single mutant runs (the API
// auth scope failed every week on exactly that). Walking up passes through the
// sandbox and reaches the real root, so these files read the same thing in both.
//
// Never imported by the server: the published image has no setup/ directory.

import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const ROOT_MARKER = join('setup', 'IdentityAtlas.psd1');

/** The nearest directory at or above `start` that holds ROOT_MARKER. */
export function findRepoRoot(start, exists = existsSync) {
  let dir = resolve(start);
  for (;;) {
    if (exists(join(dir, ROOT_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`No Identity Atlas checkout at or above ${start} (looked for ${ROOT_MARKER}).`);
    }
    dir = parent;
  }
}

let cached;
/** The repository root this file lives in. */
export function repoRoot() {
  cached ??= findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  return cached;
}
