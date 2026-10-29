// @vitest-environment jsdom
// One scroll container for the grid, never the page's and the grid's together:
// wide, the grid and panel share a row sized to the rest of the window and each
// scrolls inside it; narrow (stacked) or too little room, nothing is capped and the
// page alone scrolls. The window width and the measured fit are stubbed.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

const fit = vi.hoisted(() => ({ height: 640 }));
vi.mock('@ui/hooks/useViewportFitHeight', () => ({ default: () => fit.height }));

import GridAndPanel, { MIN_GRID_ROW_HEIGHT } from './GridAndPanel';
import { useWideLayout, WIDE_QUERY } from './useWideLayout';

function mockWidth(wide) {
  const listeners = new Set();
  const mq = { matches: wide, addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f) };
  window.matchMedia = vi.fn(() => mq);
  return { set: (next) => { mq.matches = next; listeners.forEach(f => f()); }, listeners };
}

const grid = vi.fn((fill) => <div data-testid="grid" data-fill={String(fill)} />);
const renderRow = () => renderWithProviders(<GridAndPanel grid={grid} panel={<p>panel</p>} deps={[]} />);
const row = () => screen.getByTestId('grid').parentElement.parentElement;

afterEach(() => { fit.height = 640; delete window.matchMedia; });

describe('GridAndPanel', () => {
  it('wide: sizes the row to the window; the grid fills it and the panel scrolls on its own', () => {
    mockWidth(true);
    renderRow();
    expect(row()).toHaveAttribute('data-fit', 'viewport');
    expect(row().style.height).toBe('640px');
    expect(screen.getByTestId('grid')).toHaveAttribute('data-fill', 'true');
    expect(screen.getByTestId('workbench-panel').className).toContain('overflow-y-auto');
    expect(screen.getByText('panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /How to read/i })).toBeInTheDocument();
  });

  it('narrow: caps nothing — the page scrolls', () => {
    mockWidth(false);
    renderRow();
    expect(row()).toHaveAttribute('data-fit', 'page');
    expect(row().style.height).toBe('');
    expect(screen.getByTestId('grid')).toHaveAttribute('data-fill', 'false');
    expect(screen.getByTestId('workbench-panel').className).not.toContain('overflow-y-auto');
  });

  it('wide but too little room for a grid under its header rows: caps nothing either', () => {
    mockWidth(true);
    fit.height = MIN_GRID_ROW_HEIGHT - 1;
    renderRow();
    expect(row()).toHaveAttribute('data-fit', 'page');
  });
});

describe('useWideLayout', () => {
  function Probe() { return <span data-testid="wide">{String(useWideLayout())}</span>; }

  it('follows the window across the breakpoint, and lets go when unmounted', () => {
    const width = mockWidth(false);
    const { unmount } = renderWithProviders(<Probe />);
    expect(window.matchMedia).toHaveBeenCalledWith(WIDE_QUERY);
    expect(screen.getByTestId('wide')).toHaveTextContent('false');
    act(() => width.set(true));
    expect(screen.getByTestId('wide')).toHaveTextContent('true');
    unmount();
    expect(width.listeners.size).toBe(0);
  });

  it('is narrow where the browser cannot tell', () => {
    delete window.matchMedia;
    renderWithProviders(<Probe />);
    expect(screen.getByTestId('wide')).toHaveTextContent('false');
  });
});

describe('GridAndPanel — no room measured', () => {
  it('caps nothing when the window leaves no measurable room', () => {
    mockWidth(true);
    fit.height = null;
    renderRow();
    expect(row()).toHaveAttribute('data-fit', 'page');
  });
});
