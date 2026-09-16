// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import TimeSeriesChart from './TimeSeriesChart';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

// TimeSeriesChart's rendered branches (empty / single-point / multi-point,
// header, dark-mode dot) are otherwise only exercised incidentally via the
// Trends tab's two-point fixtures. Pin them here so the extracted sub-parts and
// the edge-case branches stay covered directly.
const twoPoints = [
  { date: '2026-05-01', value: 10 },
  { date: '2026-06-01', value: 40 },
];

describe('TimeSeriesChart', () => {
  it('renders the empty state when there is no data', () => {
    renderWithProviders(h(TimeSeriesChart, { data: [] }));
    expect(screen.getByText(/No data yet/)).toBeInTheDocument();
  });

  it('renders the title and subtitle header when provided', () => {
    renderWithProviders(h(TimeSeriesChart, { data: twoPoints, title: 'Users', subtitle: '40 today' }));
    expect(screen.getByText('Users')).toBeInTheDocument();
    expect(screen.getByText('40 today')).toBeInTheDocument();
  });

  it('draws a fill + line + dot and one hover rect per point for a multi-point series', () => {
    const { container } = renderWithProviders(h(TimeSeriesChart, { data: twoPoints }));
    expect(container.querySelectorAll('path')).toHaveLength(2);       // fill area + line
    expect(container.querySelector('circle')).toBeInTheDocument();    // last-point dot
    expect(container.querySelectorAll('rect')).toHaveLength(twoPoints.length);
  });

  it('renders only a dot (no line path) for a single-point series', () => {
    const { container } = renderWithProviders(
      h(TimeSeriesChart, { data: [{ date: '2026-05-01', value: 5 }] }),
    );
    expect(container.querySelectorAll('path')).toHaveLength(0);       // a line needs >1 point
    expect(container.querySelector('circle')).toBeInTheDocument();
    expect(container.querySelectorAll('rect')).toHaveLength(1);
  });

  it('uses the dark last-point dot stroke in dark mode', () => {
    const { container } = renderWithProviders(
      h(TimeSeriesChart, { data: twoPoints }),
      { theme: { isDark: true, mode: 'dark' } },
    );
    expect(container.querySelector('circle')).toHaveAttribute('stroke', '#0f172a');
  });

  it('shows the point value + unit in the hover tooltip', () => {
    const { container } = renderWithProviders(h(TimeSeriesChart, { data: twoPoints, yUnit: '%' }));
    const tooltips = [...container.querySelectorAll('title')].map(t => t.textContent);
    expect(tooltips).toContain('2026-06-01: 40%');
  });
});
