import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'MatrixView.jsx'), 'utf8');
// The nested-group expand behaviour (the /groups-with-nested fetch, etc.) now
// lives in this hook; MatrixView wires it up with the auth-wrapped client.
const nestedHookSrc = readFileSync(join(here, '..', 'hooks', 'useNestedGroupExpand.js'), 'utf8');

describe('MatrixView', () => {
  it('tracks async loading state for nested groups and identity columns', () => {
    expect(src).toContain('loadingNested');
    expect(src).toContain('loadingIdentityCols');
  });

  it('shows an empty state before a slice is picked and when no data exists', () => {
    expect(src).toContain('Pick a slice to inspect');
    expect(src).toContain('No data available yet');
  });

  it('fetches expandable groups through the auth-wrapped client', () => {
    expect(src).toContain('useAuth()');
    // MatrixView passes authFetch into the nested-expand hook, which fetches.
    expect(src).toContain('useNestedGroupExpand');
    expect(nestedHookSrc).toContain('/api/groups-with-nested');
  });
});
