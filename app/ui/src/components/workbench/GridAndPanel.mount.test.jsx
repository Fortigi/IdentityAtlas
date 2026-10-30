// @vitest-environment jsdom
// The grid and the candidate panel: one vertical scrollbar, the page's. Neither
// the grid nor the row caps its height; the panel sticks to the top of the window
// beside the grid and scrolls within itself only when taller than the window.
import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';
import GridAndPanel from './GridAndPanel';

describe('GridAndPanel', () => {
  it('lays the grid, the legend and the panel out without a height of their own', () => {
    renderWithProviders(<GridAndPanel grid={<div data-testid="grid" />} panel={<p>panel</p>} />);
    const row = screen.getByTestId('grid').parentElement.parentElement;
    expect(row.style.height).toBe('');
    expect(row.className).not.toMatch(/overflow|h-screen/);
    expect(screen.getByRole('button', { name: /How to read/i })).toBeInTheDocument();
    expect(screen.getByText('panel')).toBeInTheDocument();
  });

  it('keeps the panel in view beside the grid, scrolling within itself only when taller than the window', () => {
    renderWithProviders(<GridAndPanel grid={<div />} panel={<p>panel</p>} />);
    const panel = screen.getByTestId('workbench-panel');
    expect(panel.className).toContain('xl:sticky');
    expect(panel.className).toContain('xl:top-0');
    expect(panel.className).toContain('xl:max-h-screen');
    expect(panel.className).toContain('xl:overflow-y-auto');
  });
});
