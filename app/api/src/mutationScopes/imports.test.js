import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  importSpecifiers, resolveSpecifier, expandTests, reachableFrom, unreachedMutated, scopeReach,
} from './imports.js';

function scratch(files) {
  const root = mkdtempSync(join(tmpdir(), 'mscope-imports-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe('importSpecifiers', () => {
  it('finds static, side-effect, re-export, dynamic, importActual and require loads', () => {
    const src = [
      "import a from './a.js';",
      "import { b, c } from '../b';",
      "import * as d from '@ui/d';",
      "import './side.css';",
      "export { e } from './e.js';",
      "const f = await import('./f.js');",
      "const g = await vi.importActual('./g.js');",
      "const h = require('./h.cjs');",
    ].join('\n');
    expect(importSpecifiers(src)).toEqual([
      './side.css', './a.js', '../b', '@ui/d', './e.js', './f.js', './g.js', './h.cjs',
    ]);
  });

  it('ignores commented-out imports and vi.mock, which loads nothing real', () => {
    const src = [
      "// import old from './old.js';",
      "/* import gone from './gone.js'; */",
      "vi.mock('./mocked.js');",
      "import kept from './kept.js';",
    ].join('\n');
    expect(importSpecifiers(src)).toEqual(['./kept.js']);
  });

  it('reports a module named twice once', () => {
    expect(importSpecifiers("import a from './a.js';\nimport { b } from './a.js';")).toEqual(['./a.js']);
  });
});

describe('resolveSpecifier', () => {
  const files = new Set(['src/a.js', 'src/b.jsx', 'src/dir/index.js', 'src/x.helpers.js', 'src/x.helpers']);
  const exists = f => files.has(f);

  it('resolves a relative path against the importing file', () => {
    expect(resolveSpecifier('src/sub/t.test.js', '../a.js', {}, exists)).toBe('src/a.js');
  });

  it('tries the bare path, then .js, .jsx and an index file, in that order', () => {
    expect(resolveSpecifier('src/t.js', './a', {}, exists)).toBe('src/a.js');
    expect(resolveSpecifier('src/t.js', './b', {}, exists)).toBe('src/b.jsx');
    expect(resolveSpecifier('src/t.js', './dir', {}, exists)).toBe('src/dir/index.js');
    expect(resolveSpecifier('src/t.js', './x.helpers', {}, exists)).toBe('src/x.helpers');
  });

  it('maps an alias prefix onto its directory', () => {
    expect(resolveSpecifier('src/deep/t.js', '@ui/a', { '@ui/': 'src' }, exists)).toBe('src/a.js');
  });

  it('returns null for a package, a missing file and a path leaving the package', () => {
    expect(resolveSpecifier('src/t.js', 'vitest', {}, exists)).toBeNull();
    expect(resolveSpecifier('src/t.js', './missing', {}, exists)).toBeNull();
    expect(resolveSpecifier('src/t.js', '../../outside.js', {}, () => true)).toBeNull();
  });
});

describe('against a scratch package', () => {
  let root;
  const pkgDir = () => join(root, 'app', 'ui');
  beforeAll(() => {
    root = scratch({
      'app/ui/src/a.js': "import { b } from './b.js';\nexport const a = 1;",
      'app/ui/src/b.js': "import { a } from './a.js';\nexport const b = 2;",
      'app/ui/src/c.js': 'export const c = 3;',
      'app/ui/src/d.jsx': "import { c } from '@ui/c.js';\nexport const d = c;",
      'app/ui/src/a.test.js': "import { a } from './a.js';",
      'app/ui/src/sub/d.mount.test.jsx': "import { d } from '../d';",
      'app/ui/src/sub/notes.md': '',
    });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('expands literal entries and globs, dropping a literal that does not exist', () => {
    expect(expandTests(pkgDir(), ['src/a.test.js', 'src/missing.test.js'])).toEqual(['src/a.test.js']);
    expect(expandTests(pkgDir(), ['src/**/*.test.{js,jsx}'])).toEqual(['src/a.test.js', 'src/sub/d.mount.test.jsx']);
  });

  it('selects nothing by glob in a package without src/', () => {
    expect(expandTests(join(root, 'app', 'api'), ['src/**/*.test.js'])).toEqual([]);
  });

  it('follows imports transitively and survives a cycle', () => {
    const reached = reachableFrom(pkgDir(), ['src/a.test.js']);
    expect([...reached].sort()).toEqual(['src/a.js', 'src/a.test.js', 'src/b.js']);
  });

  it('follows an aliased import only when the alias is given', () => {
    expect(reachableFrom(pkgDir(), ['src/sub/d.mount.test.jsx'], { '@ui/': 'src' })).toContain('src/c.js');
    expect(reachableFrom(pkgDir(), ['src/sub/d.mount.test.jsx'])).not.toContain('src/c.js');
  });

  it('names the mutated files nothing reaches, skipping negated entries', () => {
    const reached = new Set(['src/a.js']);
    expect(unreachedMutated(['src/a.js', 'src/c.js', '!src/c.js'], reached)).toEqual(['src/c.js']);
  });

  it('scopeReach reports dead entries and unreached files for one declaration', () => {
    const scope = (tests, mutate) => ({ pkg: 'ui', cfg: { tests, mutate } });
    expect(scopeReach(root, scope(['src/a.test.js'], ['src/a.js', 'src/b.js', 'src/c.js'])))
      .toEqual({ deadEntries: [], unreached: ['src/c.js'] });
    expect(scopeReach(root, scope(['src/sub/*.test.jsx', 'src/gone.test.js'], ['src/c.js'])))
      .toEqual({ deadEntries: ['src/gone.test.js'], unreached: [] });
    expect(scopeReach(root, { pkg: 'ui', cfg: {} })).toEqual({ deadEntries: [], unreached: [] });
  });
});
