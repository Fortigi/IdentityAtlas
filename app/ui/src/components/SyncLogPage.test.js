import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'SyncLogPage.jsx'), 'utf8');

describe('Sync Log record count', () => {
  it('guards a null/undefined RecordCount so a single bad row cannot crash the page', () => {
    // RecordCount can be null on a partial row; calling .toLocaleString() on it
    // directly would crash the whole page. Every line that formats RecordCount
    // must also null-guard it on the same statement (`!= null` or `?? 0`).
    // Implementation-agnostic so it survives refactors of the page.
    const unguarded = src
      .split('\n')
      .filter((line) => /RecordCount\.toLocaleString\(\)/.test(line)
        && !/RecordCount != null/.test(line)
        && !/RecordCount \?\? 0/.test(line)
        && !/RecordCount \|\| 0/.test(line));
    expect(unguarded).toEqual([]);
  });
});
