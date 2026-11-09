// @vitest-environment jsdom
// The band above the role columns: where the proposed roles start, a gap with a
// faint dashed line and "Proposed"; elsewhere as before.
import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';
import MatrixApBandCell from './MatrixApBandCell';
import MatrixApLabelCell from './MatrixApLabelCell';
import { PROPOSED_GAP_CLASS } from './MatrixColumnHeaders.helpers';

const APS = [
  { id: 'br', displayName: 'Claims handler — Motor', categoryName: null },
  { id: 'p1', displayName: 'Draft: Handler', categoryName: 'Proposed' },
  { id: 'p2', displayName: 'Draft: Lead', categoryName: 'Proposed' },
];
const cells = (C) => {
  renderWithProviders(<table><thead><tr>{APS.map((ap, idx) => <C key={ap.id} accessPackages={APS} idx={idx} isDark={false} />)}</tr></thead></table>);
  return [...document.querySelectorAll('th')];
};

describe('the role bands with proposed roles added', () => {
  it('labels the group "Proposed" once, over a gap before its first band', () => {
    const [br, p1, p2] = cells(MatrixApBandCell);
    expect(screen.getAllByText('Proposed')).toHaveLength(1);
    expect(p1).toHaveTextContent('Proposed');
    expect(p1.className).toContain(PROPOSED_GAP_CLASS);
    expect(p1.style.backgroundImage).toContain('repeating-linear-gradient');
    for (const c of [br, p2]) {
      expect(c.className).not.toContain(PROPOSED_GAP_CLASS);
      expect(c.style.backgroundImage).toBe('');
    }
  });

  it('opens the same gap on the names row, so the columns line up', () => {
    const [, p1, p2] = cells(MatrixApLabelCell);
    expect(p1.className).toContain(PROPOSED_GAP_CLASS);
    expect(p2.className).not.toContain(PROPOSED_GAP_CLASS);
  });
});
