// `npm run mutation-scopes:check` / `npm run mutation-scopes:generate` (app/api).
//
//   check     exit 1 when a vitest.stryker.<scope>.config.js is missing, stale or has
//             no stryker.<scope>.config.json, or a declaration is malformed.
//   generate  rewrite the stale and missing ones from the declarations.

import { writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { plan } from './scopes.js';
import { repoRoot } from '../lib/repoRoot.js';

const USAGE = 'usage: node src/mutationScopes/cli.js <check|generate>';

/** CLI entry point; returns the process exit code. */
export function main(argv, io = console, root = repoRoot()) {
  const cmd = argv[0];
  if (cmd !== 'check' && cmd !== 'generate') {
    io.error(USAGE);
    return 2;
  }
  const { scopes, errors, stale, orphans } = plan(root);
  const problems = [
    ...errors,
    ...orphans.map(p => `${p}: no stryker.<scope>.config.json declares it; delete it or add the declaration`),
  ];
  if (cmd === 'generate') {
    for (const { path, text } of stale) {
      writeFileSync(join(root, path), text);
      io.log(`updated ${path}`);
    }
  } else {
    problems.push(...stale.map(s => `${s.path}: out of date — run \`npm run mutation-scopes:generate\` in app/api`));
  }
  if (problems.length) {
    io.error(`Mutation scope check failed — ${problems.length} finding(s):\n${problems.map(p => `  ${p}`).join('\n')}`);
    return 1;
  }
  io.log(cmd === 'generate' && stale.length
    ? `Generated ${stale.length} file(s) for ${scopes.length} scope(s).`
    : `All ${scopes.length} mutation scopes are up to date.`);
  return 0;
}

/* v8 ignore next 3 -- the process entry point; main() itself is tested */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
