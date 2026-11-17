import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join, resolve, sep } from 'path';
import { findRepoRoot, repoRoot, ROOT_MARKER } from './repoRoot.js';

// A fake filesystem: only the listed directories hold the marker.
const fsWithRootAt = (...roots) => {
  const markers = new Set(roots.map(r => join(resolve(r), ROOT_MARKER)));
  return p => markers.has(p);
};

describe('findRepoRoot', () => {
  const root = resolve('/work/IdentityAtlas');

  it('walks up from a nested directory to the one holding the marker', () => {
    expect(findRepoRoot(join(root, 'app', 'api', 'src', 'auth'), fsWithRootAt(root))).toBe(root);
  });

  it('passes through a Stryker sandbox to the real checkout', () => {
    // Counting four directories up from the sandbox's src/auth lands on app/api;
    // the walk keeps going to the directory that actually is the root.
    const sandboxed = join(root, 'app', 'api', '.stryker-tmp', 'sandbox-x1', 'src', 'auth');
    expect(findRepoRoot(sandboxed, fsWithRootAt(root))).toBe(root);
  });

  it('returns the start itself when it is the root', () => {
    expect(findRepoRoot(root, fsWithRootAt(root))).toBe(root);
  });

  it('stops at the NEAREST root when checkouts are nested', () => {
    const inner = join(root, 'vendor', 'copy');
    expect(findRepoRoot(join(inner, 'app', 'api'), fsWithRootAt(root, inner))).toBe(inner);
  });

  it('throws, naming the marker, when no checkout is above the start', () => {
    expect(() => findRepoRoot(join(root, 'app'), () => false)).toThrow(/setup.IdentityAtlas\.psd1/);
  });
});

describe('repoRoot', () => {
  it('is the real checkout this test runs in', () => {
    const r = repoRoot();
    expect(existsSync(join(r, ROOT_MARKER))).toBe(true);
    expect(existsSync(join(r, 'app', 'api', 'src', 'lib', 'repoRoot.js'))).toBe(true);
    expect(r.endsWith(`${sep}app`)).toBe(false);
  });

  it('is computed once', () => {
    expect(repoRoot()).toBe(repoRoot());
  });
});
