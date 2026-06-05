import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The matrix Tags column was removed (tags are no longer a meaningful axis
// here). Guard against it creeping back into the header or the group rows.
const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');

describe('matrix Tags column removed', () => {
  it('column header no longer renders a Tags header cell', () => {
    expect(read('MatrixColumnHeaders.jsx')).not.toMatch(/>\s*Tags\s*</);
  });
  it('group rows no longer render a tags cell', () => {
    expect(read('MatrixGroupRow.jsx')).not.toContain('group.tags');
  });
});
