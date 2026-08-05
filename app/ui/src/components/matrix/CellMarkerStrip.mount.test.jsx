// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import CellMarkerStrip from './CellMarkerStrip';
import { hasCellMarkers, CELL_BOX_STYLE, MARKER_STRIP_HEIGHT, CELL_SIZE } from './cellMarkers';
import { renderWithProviders } from '@ui/test-utils/renderWithProviders';

// Requestor feedback on #370: the white "covered by N business roles" bubble was
// drawn over the labels of the neighbouring cells. Every marker now lives in a
// strip that the cell reserves for it, in one of three fixed slots — so a marker
// can never be painted over the cell's own badge, nor reach another cell.

function renderMarkers(props = {}) {
  const { container } = renderWithProviders(h('div', null, h(CellMarkerStrip, props)));
  return container.querySelector('span');
}

const slots = (strip) => [...strip.children];

describe('hasCellMarkers', () => {
  it('is false for a cell with nothing to say', () => {
    expect(hasCellMarkers({})).toBe(false);
    expect(hasCellMarkers({ apCount: 1, extraAccessCount: 0, missingAccessCount: 0 })).toBe(false);
  });

  it('is true for each kind of marker', () => {
    expect(hasCellMarkers({ apCount: 2 })).toBe(true);
    expect(hasCellMarkers({ provisioningGap: true })).toBe(true);
    expect(hasCellMarkers({ overGrant: 'Eligible' })).toBe(true);
    expect(hasCellMarkers({ extraAccessCount: 1 })).toBe(true);
    expect(hasCellMarkers({ missingAccessCount: 1 })).toBe(true);
  });
});

describe('CellMarkerStrip', () => {
  it('renders nothing at all when the cell carries no marker', () => {
    expect(renderMarkers({ apCount: 1 })).toBeNull();
  });

  it('reserves the top of the cell for the strip, so no marker overlaps the badge', () => {
    // The badge row gets what is left: markers and badges never share pixels,
    // and nothing is positioned outside the cell's own box.
    expect(CELL_BOX_STYLE.padding).toBe(`${MARKER_STRIP_HEIGHT}px 0 0`);
    expect(CELL_BOX_STYLE.height).toBe(`${CELL_SIZE}px`);
    expect(CELL_BOX_STYLE.position).toBe('relative');
    expect(MARKER_STRIP_HEIGHT).toBeLessThan(CELL_SIZE);

    const strip = renderMarkers({ apCount: 3 });
    expect(strip.className).toContain('absolute');
    expect(strip.className).toContain('top-0');
    // No negative offset anywhere — that is what used to reach into the
    // neighbouring cells.
    expect(strip.className).not.toMatch(/-(top|bottom|left|right)-/);
  });

  it('always keeps three slots so a marker means the same thing wherever it is', () => {
    const strip = renderMarkers({ apCount: 2 });
    expect(slots(strip)).toHaveLength(3);
    // Only the middle slot is filled — the outer two hold its place.
    expect(slots(strip)[1]).toHaveTextContent('2');
    expect(slots(strip)[0]).toHaveTextContent('');
    expect(slots(strip)[2]).toHaveTextContent('');
  });

  it('puts fewer on the left, the role count in the middle and more on the right', () => {
    const strip = renderMarkers({ missingAccessCount: 1, apCount: 4, extraAccessCount: 3 });
    const [fewer, count, more] = slots(strip);
    expect(fewer).toHaveTextContent('1');
    expect(fewer.className).toContain('bg-amber-500');
    expect(count).toHaveTextContent('4');
    expect(more).toHaveTextContent('3');
    expect(more.className).toContain('bg-rose-600');
  });

  it('shares the amber slot between the gap and the folded-role count', () => {
    expect(slots(renderMarkers({ provisioningGap: true }))[0]).toHaveTextContent('!');
    // A folded role's own count is the more specific statement, so it wins.
    expect(slots(renderMarkers({ provisioningGap: true, missingAccessCount: 2 }))[0])
      .toHaveTextContent('2');
  });

  it('shares the red slot between the over-grant and the folded-role count', () => {
    expect(slots(renderMarkers({ overGrant: 'Eligible' }))[2]).toHaveTextContent('+');
    const both = slots(renderMarkers({ overGrant: 'Eligible', extraAccessCount: 5 }))[2];
    expect(both).toHaveTextContent('5');
    expect(both).not.toHaveTextContent('+');
  });
});
