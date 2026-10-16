// Guard: every import() in the API names its module literally.
//
// The portable build bundles the API into one file with esbuild
// (scripts/build-node-launcher.mjs). esbuild follows import('./x.js'), but an
// import(variable) is left as it is and resolved at run time against the bundle's
// own folder, where ./x.js does not exist. Docker runs the sources unbundled, so
// nothing else notices: the report generator's warm-up failed this way in every
// portable build ("Cannot find module ...nlreports/service.js") while Docker was
// fine. Loading a file from disk on purpose (a crawler's own script) uses a
// file URL and is listed below.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'api', 'src');
const RUNTIME_PATH_IMPORTS = new Set([
  'routes/jobs/runs.js',   // a crawler's discover script, found on disk at run time
]);

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.js') && !e.name.endsWith('.test.js') ? [p] : [];
  });
}

describe('API dynamic imports', () => {
  it('name their module literally, so the portable bundle contains it', () => {
    const offenders = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (RUNTIME_PATH_IMPORTS.has(rel)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/(?<![\w.])import\(\s*[^'"`\s)]/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the allow-list still points at real import(variable) sites', () => {
    for (const rel of RUNTIME_PATH_IMPORTS) {
      expect(readFileSync(join(SRC, rel), 'utf8')).toMatch(/import\(\s*pathToFileURL\(/);
    }
  });
});
