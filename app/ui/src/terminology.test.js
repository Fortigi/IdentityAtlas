import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guards against internal/legacy jargon leaking back into user-facing strings.
// Targeted at specific files + phrases so it won't false-positive on code
// comments. Seed of the "terminology linter" proposed in the UX audit.
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

describe('user-facing terminology', () => {
  it('Excel export does not use the German "SOLL" jargon', () => {
    expect(read('utils/exportToExcel.js')).not.toContain('SOLL');
  });

  it('Dashboard Trends presents Business Role as one concept (not "Access Package or Business Role")', () => {
    expect(read('components/DashboardTrendsTab.jsx')).not.toContain('Access Package or Business Role');
  });
});
