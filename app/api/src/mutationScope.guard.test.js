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
//
// And a mutated file is measured against its OWN tests: each test beside it that is
// named after it must be in its scope's Vitest include list, or carry a written reason
// in that config's `testExclusions`. Four scopes once mutated files whose tests were not
// listed (language.js scored 0%, usePageVirtualRows.js 6%), so the score measured tests
// that never call the code, and every mutant paid for the ones that did not.
import { describe, it, expect } from 'vitest';
import {
  readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative, dirname, basename, matchesGlob } from 'path';
import { repoRoot as findCheckoutRoot } from './lib/repoRoot.js';

const repoRoot = findCheckoutRoot();

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

// The include list of a scope's Vitest config: the quoted entries of the `include: [...]`
// under `test:`, comments stripped. null when the config has none of its own.
export function includeList(source) {
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  const m = code.match(/test:\s*\{[\s\S]*?\binclude:\s*\[([\s\S]*?)\]/);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : null;
}

const TEST_FILE = /\.(test|spec)\.jsx?$/;
const stem = f => basename(f).replace(/\.jsx?$/, '');

// A test's owner is the source file beside it whose name it extends, the longest such
// name winning: autofix.activity.test.js belongs to autofix.activity.js, not autofix.js;
// WorkbenchPage.save.mount.test.jsx to WorkbenchPage.jsx.
export function ownTests(source, siblings) {
  const sources = siblings.filter(f => /\.jsx?$/.test(f) && !TEST_FILE.test(f));
  return siblings.filter(t => {
    if (!TEST_FILE.test(t)) return false;
    const owners = sources.filter(s => t.startsWith(`${stem(s)}.`));
    if (owners.length === 0) return false;
    const owner = owners.reduce((a, b) => (stem(b).length > stem(a).length ? b : a));
    return owner === source;
  });
}

export function unlistedOwnTests({ pkg, cfg }, root = repoRoot) {
  const pkgDir = join(root, 'app', pkg);
  const configFile = join(pkgDir, cfg.vitest?.configFile ?? 'vitest.config.js');
  const include = includeList(readFileSync(configFile, 'utf8')) ?? [];
  const waived = cfg.testExclusions ?? {};
  const missing = [];
  for (const m of cfg.mutate ?? []) {
    if (m.startsWith('!')) continue;
    const dir = dirname(m);
    if (!existsSync(join(pkgDir, dir))) continue;
    for (const t of ownTests(basename(m), readdirSync(join(pkgDir, dir)))) {
      const test = `${dir}/${t}`;
      if (include.some(p => p === test || matchesGlob(test, p)) || test in waived) continue;
      missing.push(`app/${pkg}/${test} (tests ${m})`);
    }
  }
  return missing;
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

  it("measures each mutated file against its own tests", () => {
    const missing = configs.flatMap(c => unlistedOwnTests(c).map(m => `${c.file}: ${m}`));
    expect(
      missing,
      "these tests are about a mutated file but are not in its scope's Vitest include list, " +
        "so its score measures other tests. List them, or give a reason in the config's " +
        '`testExclusions` (e.g. the test reads files outside the Stryker sandbox).\n' +
        missing.join('\n'),
    ).toEqual([]);
  });

  it('every test exclusion carries a written reason', () => {
    const thin = configs.flatMap(({ file, cfg }) =>
      Object.entries(cfg.testExclusions ?? {})
        .filter(([, r]) => typeof r !== 'string' || r.trim().length < 40)
        .map(([t]) => `${file}: ${t}`));
    expect(thin, 'test exclusions need a real reason (40+ chars)').toEqual([]);
  });

  it('every exclusion carries a non-trivial written reason', () => {
    // Same rule as the PowerShell config: an exclusion without a reason is just a
    // silent hole with extra steps.
    const thin = [...excluded.entries()].filter(([, r]) => typeof r !== 'string' || r.trim().length < 40);
    expect(thin.map(([f]) => f), 'exclusions need a real reason (40+ chars)').toEqual([]);
  });
});

describe('the own-tests rule', () => {
  it("reads a config's include list, not the base config's or a commented-out one", () => {
    const src = [
      "import base from './vitest.config.js';",
      'export default defineConfig({',
      '  ...base,',
      '  test: {',
      '    ...base.test,',
      '    include: [',
      "      'src/a/foo.test.js',",
      "      // 'src/a/old.test.js',",
      "      'src/b/**/*.test.js',",
      '    ],',
      "    exclude: ['**/node_modules/**'],",
      '  },',
      '});',
    ].join('\n');
    expect(includeList(src)).toEqual(['src/a/foo.test.js', 'src/b/**/*.test.js']);
  });

  it('says when a config has no include of its own', () => {
    expect(includeList("export default { test: { exclude: ['x'] } };")).toBeNull();
  });

  it("gives a test to the longest source name it extends", () => {
    const dir = [
      'autofix.js', 'autofix.activity.js', 'autofix.test.js', 'autofix.activity.test.js',
      'autofix.retry.test.js', 'Page.jsx', 'Page.save.mount.test.jsx', 'Pager.test.js', 'notes.md',
    ];
    expect(ownTests('autofix.js', dir)).toEqual(['autofix.test.js', 'autofix.retry.test.js']);
    expect(ownTests('autofix.activity.js', dir)).toEqual(['autofix.activity.test.js']);
    expect(ownTests('Page.jsx', dir)).toEqual(['Page.save.mount.test.jsx']);
  });

  it('flags an unlisted own test, and accepts a listed, globbed or waived one', () => {
    const root = mkdtempSync(join(tmpdir(), 'mscope-'));
    const pkgDir = join(root, 'app', 'api');
    mkdirSync(join(pkgDir, 'src', 'x'), { recursive: true });
    for (const f of ['a.js', 'a.test.js', 'b.js', 'b.test.js', 'c.js', 'c.test.js']) {
      writeFileSync(join(pkgDir, 'src', 'x', f), '');
    }
    writeFileSync(join(pkgDir, 'v.js'), "export default { test: { include: ['src/x/a.test.js'] } };");
    writeFileSync(join(pkgDir, 'g.js'), "export default { test: { include: ['src/**/*.test.js'] } };");
    const scope = (vitest, extra = {}) => ({
      pkg: 'api',
      cfg: { vitest: { configFile: vitest }, mutate: ['src/x/a.js', 'src/x/b.js', 'src/x/c.js'], ...extra },
    });
    try {
      expect(unlistedOwnTests(scope('v.js'), root)).toEqual([
        'app/api/src/x/b.test.js (tests src/x/b.js)',
        'app/api/src/x/c.test.js (tests src/x/c.js)',
      ]);
      expect(unlistedOwnTests(scope('g.js'), root)).toEqual([]);
      expect(unlistedOwnTests(scope('v.js', { testExclusions: { 'src/x/b.test.js': 'r' } }), root))
        .toEqual(['app/api/src/x/c.test.js (tests src/x/c.js)']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
