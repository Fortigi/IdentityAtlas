import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'RunDetailPage.jsx'), 'utf8');

describe('Run detail — "Go there now" navigation', () => {
  it('no longer opens a context detail tab with a null id', () => {
    expect(src).not.toMatch(/onOpenDetail\?\.\('context',\s*null\)/);
  });
  it('navigates to the Contexts page instead', () => {
    expect(src).toContain("window.location.hash = 'contexts'");
  });
});
