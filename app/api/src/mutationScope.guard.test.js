// Hard-rule guard for mutation-testing SCOPE across the JavaScript tree.
//
// The number that matters is not the mutation score, it is how much code the score
// covers. On the PowerShell side the guard enumerated one directory while its headline
// assertion claimed the whole tree, so 103 untriaged files and zero untriaged files
// produced the same green tick. That is the failure this prevents here.
//
// Every eligible .js/.jsx file under app/api/src and app/ui/src must be exactly one of:
//   1. mutation-tested  - listed in a Stryker config's `mutate`
//   2. excluded         - given a written reason in that config's `mutationExclusions`
//   3. grandfathered    - listed in .ci/js-mutation-scope-baseline.json
//
// (3) may only shrink. A NEW file is never allowed into it, so new code has to be
// decided on when it lands instead of accumulating quietly.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SKIP_DIRS = new Set([
  'node_modules', '__tests__', 'test-utils', 'mock', 'coverage', 'dist', 'build',
]);

function walk(dir, exts, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, exts, acc);
    } else if (exts.some(e => entry.endsWith(e)) && !/\.(test|spec)\./.test(entry)) {
      acc.push(relative(repoRoot, full).split('\\').join('/'));
    }
  }
  return acc;
}

function strykerConfigs() {
  // Every stryker*.config.json under app/*, each contributing its own mutate list and
  // (optionally) its written exclusions.
  const found = [];
  for (const pkg of ['api', 'ui']) {
    const dir = join(repoRoot, 'app', pkg);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/^stryker.*\.config\.json$/.test(f)) continue;
      const cfg = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      found.push({ file: `app/${pkg}/${f}`, pkg, cfg });
    }
  }
  return found;
}

const eligible = [
  ...walk(join(repoRoot, 'app', 'api', 'src'), ['.js']),
  ...walk(join(repoRoot, 'app', 'ui', 'src'), ['.js', '.jsx']),
];

const configs = strykerConfigs();
const mutated = new Set();
const excluded = new Map();
for (const { pkg, cfg } of configs) {
  for (const m of cfg.mutate ?? []) mutated.add(`app/${pkg}/${m}`);
  for (const [k, reason] of Object.entries(cfg.mutationExclusions ?? {})) {
    excluded.set(`app/${pkg}/${k}`, reason);
  }
}

const baselinePath = join(repoRoot, '.ci', 'js-mutation-scope-baseline.json');
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const grandfathered = new Set(baseline.grandfathered);

describe('JavaScript mutation-testing scope', () => {
  it('finds the source trees at all', () => {
    // The guard is worthless if its walk returns nothing: an empty list satisfies
    // "every file is decided" vacuously, which is precisely how the PowerShell version
    // reported full coverage of a decision nobody had made.
    expect(eligible.length).toBeGreaterThan(300);
    expect(eligible).toContain('app/api/src/auth/permissions.js');
    expect(eligible).toContain('app/ui/src/utils/matrixFilter.js');
  });

  it('reads at least one Stryker config, with files in it', () => {
    expect(configs.length).toBeGreaterThan(0);
    expect(mutated.size).toBeGreaterThan(0);
  });

  it('leaves no eligible file undecided', () => {
    const undecided = eligible.filter(
      f => !mutated.has(f) && !excluded.has(f) && !grandfathered.has(f),
    );
    expect(
      undecided,
      `${undecided.length} JS file(s) are neither mutation-tested, excluded with a reason, ` +
        'nor grandfathered. New code must be decided on when it lands: add it to a Stryker ' +
        "config's `mutate`, or give it a written reason in `mutationExclusions`. Do NOT add it " +
        `to .ci/js-mutation-scope-baseline.json - that list may only shrink.\n${undecided.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps the backlog free of files that no longer exist or are already covered', () => {
    // Stops the list from drifting into fiction: a stale entry makes the backlog look
    // bigger than it is, and an entry that is now mutation-tested makes it look smaller.
    const live = new Set(eligible);
    const stale = baseline.grandfathered.filter(f => !live.has(f));
    const alreadyCovered = baseline.grandfathered.filter(f => mutated.has(f) || excluded.has(f));
    expect(stale, `stale backlog entries (file gone):\n${stale.join('\n')}`).toEqual([]);
    expect(
      alreadyCovered,
      `these are covered now and should be removed from the backlog:\n${alreadyCovered.join('\n')}`,
    ).toEqual([]);
  });

  it('every exclusion carries a non-trivial written reason', () => {
    // Same rule as the PowerShell config: an exclusion without a reason is just a
    // silent hole with extra steps.
    const thin = [...excluded.entries()].filter(([, r]) => typeof r !== 'string' || r.trim().length < 40);
    expect(thin.map(([f]) => f), 'exclusions need a real reason (40+ chars)').toEqual([]);
  });
});
