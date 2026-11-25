import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { main } from './cli.js';

function capture() {
  const out = { log: [], error: [] };
  return { io: { log: m => out.log.push(m), error: m => out.error.push(m) }, out };
}

const decl = name => JSON.stringify({
  vitest: { configFile: `vitest.stryker.${name}.config.js` },
  mutate: ['src/a.js'],
  tests: ['src/a.test.js'],
});

describe('mutation-scopes CLI', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mscope-cli-'));
    mkdirSync(join(root, 'app', 'api'), { recursive: true });
    writeFileSync(join(root, 'app', 'api', 'stryker.a.config.json'), decl('a'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('check fails on a missing generated file and says how to fix it', () => {
    const { io, out } = capture();
    expect(main(['check'], io, root)).toBe(1);
    expect(out.error).toEqual([
      'Mutation scope check failed — 1 finding(s):\n' +
        '  app/api/vitest.stryker.a.config.js: out of date — run `npm run mutation-scopes:generate` in app/api',
    ]);
  });

  it('generate writes it, after which check passes and generate has nothing to do', () => {
    const gen = capture();
    expect(main(['generate'], gen.io, root)).toBe(0);
    expect(gen.out.log).toEqual(['updated app/api/vitest.stryker.a.config.js', 'Generated 1 file(s) for 1 scope(s).']);
    expect(readFileSync(join(root, 'app/api/vitest.stryker.a.config.js'), 'utf8')).toContain("      'src/a.test.js',");

    const check = capture();
    expect(main(['check'], check.io, root)).toBe(0);
    expect(check.out).toEqual({ log: ['All 1 mutation scopes are up to date.'], error: [] });

    const again = capture();
    expect(main(['generate'], again.io, root)).toBe(0);
    expect(again.out.log).toEqual(['All 1 mutation scopes are up to date.']);
  });

  it('generate still fails on an orphan or a malformed declaration, writing what it can', () => {
    writeFileSync(join(root, 'app', 'api', 'vitest.stryker.gone.config.js'), '');
    writeFileSync(join(root, 'app', 'api', 'stryker.b.config.json'), JSON.stringify({ vitest: { configFile: 'vitest.stryker.b.config.js' } }));
    const { io, out } = capture();
    expect(main(['generate'], io, root)).toBe(1);
    expect(out.log).toEqual(['updated app/api/vitest.stryker.a.config.js']);
    expect(out.error).toEqual([
      'Mutation scope check failed — 2 finding(s):\n' +
        '  app/api/stryker.b.config.json: `tests` must be a non-empty list of test files or globs\n' +
        '  app/api/vitest.stryker.gone.config.js: no stryker.<scope>.config.json declares it; delete it or add the declaration',
    ]);
  });

  it('prints usage and exits 2 for an unknown or missing command', () => {
    for (const argv of [['frobnicate'], []]) {
      const { io, out } = capture();
      expect(main(argv, io, root)).toBe(2);
      expect(out.error).toEqual(['usage: node src/mutationScopes/cli.js <check|generate>']);
    }
  });

  it('checks the real checkout by default, which is up to date', () => {
    const { io, out } = capture();
    expect(main(['check'], io)).toBe(0);
    expect(out.log[0]).toMatch(/^All \d+ mutation scopes are up to date\.$/);
  });
});
