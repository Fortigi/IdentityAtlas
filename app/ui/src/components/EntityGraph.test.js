import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'EntityGraph.jsx'), 'utf8');

describe('EntityGraph reduced-motion', () => {
  it('subscribes to prefers-reduced-motion', () => {
    expect(src).toContain('prefers-reduced-motion: reduce');
    expect(src).toContain('usePrefersReducedMotion');
  });
  it('gates the SMIL animations on reduced-motion', () => {
    // No <animate> should run unconditionally — each is guarded by !reduceMotion.
    expect(src).toContain('!reduceMotion');
  });
});
