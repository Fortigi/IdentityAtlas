import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readScopes, renderVitestConfig, declarationErrors, plan, vitestFileFor } from './scopes.js';

const decl = (name, extra = {}) => ({
  vitest: { configFile: vitestFileFor(name) },
  mutate: ['src/a.js'],
  tests: ['src/a.test.js'],
  ...extra,
});

describe('renderVitestConfig', () => {
  it('writes the API template: the base config spread, thresholds off, the list in order', () => {
    const text = renderVitestConfig('api', 'auth', ['src/b.test.js', 'src/a/**/*.test.js']);
    expect(text.split('\n')[0]).toBe('// GENERATED from stryker.auth.config.json by `npm run mutation-scopes:generate`');
    expect(text).toContain("import base from './vitest.config.js';");
    expect(text).toContain([
      '    ...base.test,',
      '    include: [',
      "      'src/b.test.js',",
      "      'src/a/**/*.test.js',",
      '    ],',
      "    exclude: ['**/node_modules/**'],",
      '    coverage: { ...base.test.coverage, thresholds: undefined },',
    ].join('\n'));
    expect(text).toContain('sandbox copy of\n// app/api,');
    expect(text).not.toContain('plugin-react');
    expect(text.endsWith('});\n')).toBe(true);
  });

  it('writes the UI template: standalone, with the react plugin and the @ui alias', () => {
    const text = renderVitestConfig('ui', 'pilot', ['src/x.test.jsx']);
    expect(text).toContain('stryker.pilot.config.json');
    expect(text).toContain("import react from '@vitejs/plugin-react';");
    expect(text).toContain("    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },");
    expect(text).toContain("  test: {\n    include: [\n      'src/x.test.jsx',\n    ],\n    exclude: ['**/node_modules/**'],\n  },");
    expect(text).toContain('sandbox copy of\n// app/ui,');
    expect(text).not.toContain('vitest.config.js');
  });
});

describe('declarationErrors', () => {
  const errs = (cfg, name = 's') => declarationErrors({ file: 'app/api/stryker.s.config.json', name, cfg });

  it('accepts a well-formed declaration', () => {
    expect(errs(decl('s'))).toEqual([]);
  });

  it('rejects a missing or empty tests list', () => {
    const msg = 'app/api/stryker.s.config.json: `tests` must be a non-empty list of test files or globs';
    expect(errs(decl('s', { tests: undefined }))).toEqual([msg]);
    expect(errs(decl('s', { tests: [] }))).toEqual([msg]);
    expect(errs(decl('s', { tests: 'src/a.test.js' }))).toEqual([msg]);
  });

  it('rejects entries outside src/, with a quote, or not strings', () => {
    expect(errs(decl('s', { tests: ['src/ok.test.js', 'test/x.test.js', "src/it's.test.js", 3] }))).toEqual([
      "app/api/stryker.s.config.json: `tests` entries must be paths under src/ without quotes: test/x.test.js, src/it's.test.js, 3",
    ]);
  });

  it('rejects a test listed twice, naming it once', () => {
    expect(errs(decl('s', { tests: ['src/a.test.js', 'src/b.test.js', 'src/a.test.js', 'src/a.test.js'] }))).toEqual([
      'app/api/stryker.s.config.json: `tests` lists src/a.test.js more than once',
    ]);
  });

  it('requires the scope to point at its own generated Vitest config', () => {
    expect(errs(decl('s', { vitest: { configFile: 'vitest.stryker.config.js' } }))).toEqual([
      'app/api/stryker.s.config.json: vitest.configFile must be "vitest.stryker.s.config.js" (got "vitest.stryker.config.js")',
    ]);
    expect(errs(decl('s', { vitest: undefined }))).toEqual([
      'app/api/stryker.s.config.json: vitest.configFile must be "vitest.stryker.s.config.js" (got "undefined")',
    ]);
  });
});

describe('against a scratch checkout', () => {
  let root;
  const write = (rel, text) => writeFileSync(join(root, rel), text);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mscope-plan-'));
    mkdirSync(join(root, 'app', 'api'), { recursive: true });
    mkdirSync(join(root, 'app', 'ui'), { recursive: true });
    write('app/api/stryker.b.config.json', JSON.stringify(decl('b')));
    write('app/api/stryker.a.config.json', JSON.stringify(decl('a')));
    write('app/ui/stryker.p.config.json', JSON.stringify(decl('p')));
    write('app/api/stryker.conf.js', '');
    write('app/api/vitest.config.js', '');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads the declarations API first, in file-name order, and nothing else', () => {
    expect(readScopes(root).map(s => `${s.pkg}/${s.name}:${s.file}`)).toEqual([
      'api/a:app/api/stryker.a.config.json',
      'api/b:app/api/stryker.b.config.json',
      'ui/p:app/ui/stryker.p.config.json',
    ]);
  });

  it('reads no scopes when a package directory is missing', () => {
    rmSync(join(root, 'app', 'ui'), { recursive: true });
    expect(readScopes(root).map(s => s.name)).toEqual(['a', 'b']);
    expect(plan(root).orphans).toEqual([]);
  });

  it('marks every missing generated file stale, and none once they match', () => {
    expect(plan(root).stale.map(s => s.path)).toEqual([
      'app/api/vitest.stryker.a.config.js',
      'app/api/vitest.stryker.b.config.js',
      'app/ui/vitest.stryker.p.config.js',
    ]);
    for (const { path, text } of plan(root).stale) write(path, text);
    expect(plan(root)).toMatchObject({ errors: [], stale: [], orphans: [] });
  });

  it('accepts CRLF line endings in a generated file but not an edited list', () => {
    write('app/api/vitest.stryker.a.config.js', renderVitestConfig('api', 'a', ['src/a.test.js']).replace(/\n/g, '\r\n'));
    write('app/api/vitest.stryker.b.config.js', renderVitestConfig('api', 'b', ['src/a.test.js', 'src/extra.test.js']));
    expect(plan(root).stale.map(s => s.path)).toEqual([
      'app/api/vitest.stryker.b.config.js',
      'app/ui/vitest.stryker.p.config.js',
    ]);
  });

  it('reports a generated file with no declaration as an orphan', () => {
    write('app/ui/vitest.stryker.gone.config.js', '');
    write('app/ui/vitest.config.js', '');
    expect(plan(root).orphans).toEqual(['app/ui/vitest.stryker.gone.config.js']);
  });

  it('does not generate for a malformed declaration, and reports why', () => {
    write('app/api/stryker.a.config.json', JSON.stringify(decl('a', { tests: [] })));
    const result = plan(root);
    expect(result.errors).toEqual(['app/api/stryker.a.config.json: `tests` must be a non-empty list of test files or globs']);
    expect(result.stale.map(s => s.path)).not.toContain('app/api/vitest.stryker.a.config.js');
    expect(result.orphans).toEqual([]);
  });
});
