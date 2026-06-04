import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'SyncLogPage.jsx'), 'utf8');

describe('Sync Log record count', () => {
  it('guards a null/undefined RecordCount so a single bad row cannot crash the page', () => {
    // Must not call .toLocaleString() directly on the possibly-null field.
    expect(src).not.toMatch(/log\.RecordCount\.toLocaleString\(\)/);
    expect(src).toContain('(log.RecordCount ?? 0).toLocaleString()');
  });
});
