// Guard over the JavaScript mutation scopes as declared (app/{api,ui}/stryker.<scope>.config.json):
//   * every generated vitest.stryker.<scope>.config.js matches its declaration;
//   * every `tests` entry selects at least one file;
//   * every mutated file is reached by at least one listed test, following imports.
// A mutated file no listed test loads has no killer in the run: every one of its
// mutants survives, or the score silently measures nothing. The weekly run would
// only show that as survivors; this fails it on the PR.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { repoRoot } from '../lib/repoRoot.js';
import { plan } from './scopes.js';
import { scopeReach } from './imports.js';

// Mutated files known to have no killer in their scope's run. Each needs a reason, and
// an entry that is reached again fails below, so the list can only shrink.
export const UNREACHED_ALLOWED = {
  'app/ui/stryker.reports.config.json': {
    'src/components/reports/ask/CompareCondition.jsx':
      'Pre-existing gap found when this guard was added (#1696): only SpecEditor.jsx imports it, and no test in this scope loads SpecEditor. Its helpers file is listed and reached; the component itself needs a mount test in the list.',
  },
  'app/ui/stryker.workbench.config.json': {
    'src/components/workbench/workbench.cells.js':
      'Pre-existing gap found when this guard was added (#1696): only the workbench components import it, and this scope lists only the logic files\' own tests. Needs a workbench.cells.test.js, or a move to the workbenchui scope.',
  },
};

/** Problems with the declared scopes' reach, as messages. */
export function reachProblems(root, scopes, allowed = UNREACHED_ALLOWED) {
  const problems = [];
  for (const scope of scopes) {
    const { deadEntries, unreached } = scopeReach(root, scope);
    const ok = allowed[scope.file] ?? {};
    for (const t of deadEntries) problems.push(`${scope.file}: \`tests\` entry ${t} matches no file`);
    for (const m of unreached.filter(f => !(f in ok))) {
      problems.push(`${scope.file}: no listed test imports ${m}, directly or through other files`);
    }
    for (const m of Object.keys(ok).filter(f => !unreached.includes(f))) {
      problems.push(`${scope.file}: ${m} is reached now — remove it from UNREACHED_ALLOWED`);
    }
  }
  return problems;
}

const root = repoRoot();
const { scopes, errors, stale, orphans } = plan(root);

describe('JavaScript mutation scopes, as declared', () => {
  it('finds every scope in both packages', () => {
    expect(scopes.length).toBeGreaterThan(20);
    expect(scopes.map(s => s.file)).toContain('app/api/stryker.auth.config.json');
    expect(scopes.map(s => s.file)).toContain('app/ui/stryker.pilot.config.json');
  });

  it('every generated Vitest config matches its declaration', () => {
    const findings = [...errors, ...stale.map(s => `${s.path} is out of date`), ...orphans.map(o => `${o} has no declaration`)];
    expect(findings, 'run `npm run mutation-scopes:generate` in app/api').toEqual([]);
  });

  it('every mutated file is reached by a listed test, and every test entry matches a file', () => {
    expect(reachProblems(root, scopes)).toEqual([]);
  }, 60_000);

  it('every allowed gap names a declared scope and gives a real reason', () => {
    const files = new Set(scopes.map(s => s.file));
    for (const [file, entries] of Object.entries(UNREACHED_ALLOWED)) {
      expect(files.has(file), file).toBe(true);
      for (const reason of Object.values(entries)) expect(reason.length).toBeGreaterThan(40);
    }
  });
});

describe('reachProblems on a broken declaration', () => {
  let scratch;
  const scope = (tests, mutate) => ({ pkg: 'api', file: 'app/api/stryker.x.config.json', cfg: { tests, mutate } });
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'mscope-guard-'));
    const files = {
      'app/api/src/route.js': "import { rule } from './rule.js';\nexport const route = rule;",
      'app/api/src/rule.js': 'export const rule = 1;',
      'app/api/src/lonely.js': 'export const lonely = 1;',
      'app/api/src/route.test.js': "import { route } from './route.js';",
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(scratch, rel)), { recursive: true });
      writeFileSync(join(scratch, rel), text);
    }
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('passes a file reached only through another module', () => {
    expect(reachProblems(scratch, [scope(['src/route.test.js'], ['src/rule.js'])], {})).toEqual([]);
  });

  it('fails a mutated file no listed test loads, and a test entry that matches nothing', () => {
    expect(reachProblems(scratch, [scope(['src/route.test.js', 'src/renamed.test.js'], ['src/rule.js', 'src/lonely.js'])], {}))
      .toEqual([
        'app/api/stryker.x.config.json: `tests` entry src/renamed.test.js matches no file',
        'app/api/stryker.x.config.json: no listed test imports src/lonely.js, directly or through other files',
      ]);
  });

  it('fails once the only killer is dropped from the list', () => {
    expect(reachProblems(scratch, [scope(['src/**/nothing.test.js'], ['src/rule.js'])], {})).toEqual([
      'app/api/stryker.x.config.json: `tests` entry src/**/nothing.test.js matches no file',
      'app/api/stryker.x.config.json: no listed test imports src/rule.js, directly or through other files',
    ]);
  });

  it('honours an allowed gap, and fails it once the file is reached again', () => {
    const allowed = { 'app/api/stryker.x.config.json': { 'src/lonely.js': 'r', 'src/rule.js': 'r' } };
    expect(reachProblems(scratch, [scope(['src/route.test.js'], ['src/rule.js', 'src/lonely.js'])], allowed)).toEqual([
      'app/api/stryker.x.config.json: src/rule.js is reached now — remove it from UNREACHED_ALLOWED',
    ]);
  });
});
