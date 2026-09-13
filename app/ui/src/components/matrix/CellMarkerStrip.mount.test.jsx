// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import CellMarkerStrip from './CellMarkerStrip';
import {
  hasCellMarkers, heldOutsideTitle, CELL_BOX_STYLE, MARKER_STRIP_HEIGHT, CELL_SIZE,
} from './cellMarkers';
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
    expect(hasCellMarkers({ heldOutsideCount: 1 })).toBe(true);
  });
});

// Requestor feedback on #370: the old wording closed on "the subject does not
// hold that role" — a claim about role membership the marker never established,
// and plainly wrong for a subject who does hold the role while the role carries
// no assignment matching this resource. What the marker actually evaluated is
// the granting role's assignments, and that is what it now says.
describe('heldOutsideTitle', () => {
  it('reports the missing assignment on the role that grants the resource', () => {
    expect(heldOutsideTitle(1, 'BR-Engineering-Tools')).toBe(
      '⚠ Held outside business-role governance: no business role assigns this resource to this subject.'
      + ' It is granted by business role BR-Engineering-Tools,'
      + ' which carries no assignment of it for this subject.');
  });

  it('reads as several roles, and drops the names when there are none', () => {
    expect(heldOutsideTitle(2, 'BR-A, BR-B')).toBe(
      '⚠ Held outside business-role governance: no business role assigns this resource to this subject.'
      + ' It is granted by 2 business roles (BR-A, BR-B),'
      + ' none of which carries an assignment of it for this subject.');
    expect(heldOutsideTitle(2)).toContain('It is granted by 2 business roles,');
    expect(heldOutsideTitle(1)).toContain(
      'It is granted by a business role, which carries no assignment of it for this subject.');
  });

  // The exact case the requestor called out: the subject DOES hold the role that
  // grants the resource, so the tooltip must say what is missing (the role's
  // assignment) instead of denying the role membership.
  it('says the subject holds the granting role when they do', () => {
    const title = heldOutsideTitle(1, 'BR-Engineering-Tools', true);
    expect(title).toBe(
      '⚠ Held outside business-role governance: this subject holds a business role that grants this resource,'
      + ' but the role does not assign it to them.'
      + ' It is granted by business role BR-Engineering-Tools,'
      + ' which carries no assignment of it for this subject.');
  });

  it('never claims the subject does not hold a business role', () => {
    for (const holds of [false, true]) {
      expect(heldOutsideTitle(1, 'BR-Engineering-Tools', holds)).not.toContain('does not hold');
      expect(heldOutsideTitle(2, 'BR-A, BR-B', holds)).not.toContain('does not hold');
    }
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

  // Requestor feedback on #370: a membership the business role above the row
  // does not hand this subject rendered as a bare badge, so the red count the
  // folded role showed for it vanished the moment the role was unfolded.
  it('marks a membership held outside the role that grants the resource', () => {
    const strip = renderMarkers({ heldOutsideCount: 1, heldOutsideNames: 'BR-Engineering-Tools' });
    const [fewer, , more] = slots(strip);
    expect(fewer).toHaveTextContent('');
    expect(more).toHaveTextContent('1');
    expect(more.className).toContain('bg-rose-600');
    expect(more.getAttribute('title')).toContain('Held outside business-role governance');
    expect(more.getAttribute('title')).toContain('BR-Engineering-Tools');
  });

  it('passes on whether the subject holds the granting role', () => {
    const more = slots(renderMarkers({
      heldOutsideCount: 1, heldOutsideNames: 'BR-Engineering-Tools', heldOutsideHoldsRole: true,
    }))[2];
    expect(more.getAttribute('title')).toContain('this subject holds a business role that grants this resource');
  });

  it('yields the red slot to a folded role\'s own count, which is more specific', () => {
    const more = slots(renderMarkers({ heldOutsideCount: 1, extraAccessCount: 2 }))[2];
    expect(more).toHaveTextContent('2');
    expect(more.getAttribute('title')).toContain('folded resources');
  });
});
