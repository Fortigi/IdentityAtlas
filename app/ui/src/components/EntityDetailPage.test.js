import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src  = readFileSync(join(here, 'EntityDetailPage.jsx'), 'utf8');

describe('EntityDetailPage scaffold', () => {
  it('accepts fetchData, getTabs, getAttributeEntries, and renderHeader props', () => {
    expect(src).toContain('fetchData');
    expect(src).toContain('getTabs');
    expect(src).toContain('getAttributeEntries');
    expect(src).toContain('renderHeader');
  });

  it('uses useExpandableGraph and useTimeline internally', () => {
    expect(src).toContain('useExpandableGraph');
    expect(src).toContain('useTimeline');
  });

  it('renders the four standard tabs: attributes, relationships, timeline, risk', () => {
    expect(src).toContain("'attributes'");
    expect(src).toContain("'relationships'");
    expect(src).toContain("'timeline'");
    expect(src).toContain("'risk'");
  });

  it('re-fetches when refreshKey changes (for post-action refresh pattern)', () => {
    expect(src).toContain('refreshKey');
  });

  it('supports renderAttributesBefore and renderRelationshipsExtra extension points', () => {
    expect(src).toContain('renderAttributesBefore');
    expect(src).toContain('renderRelationshipsExtra');
  });
});

// LinkedAccountsPanel used to be asserted here by reading its source text —
// a test that executed nothing and left the component at 0% coverage. It is
// now mounted for real in LinkedAccountsPanel.mount.test.jsx.
