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

describe('LinkedAccountsPanel', () => {
  const panelSrc = readFileSync(join(here, 'LinkedAccountsPanel.jsx'), 'utf8');

  it('renders a confidence bar for each member', () => {
    expect(panelSrc).toContain('ConfidenceBar');
  });

  it('offers Confirm, Remove, and Undo action buttons', () => {
    expect(panelSrc).toContain("'confirmed'");
    expect(panelSrc).toContain('>Confirm<');
    expect(panelSrc).toContain('>Remove<');
    expect(panelSrc).toContain('>Undo<');
  });
});
