// @vitest-environment jsdom
//
// Report notices: drawn above the table, styled by the notice's own severity.

import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';
import ReportNotices from '@ui/components/reports/ReportNotices';

describe('ReportNotices', () => {
  it('renders nothing when there are no notices', () => {
    const { container: empty } = renderWithProviders(<ReportNotices notices={[]} />);
    expect(empty).toBeEmptyDOMElement();
  });

  it('renders nothing when notices is missing', () => {
    const { container } = renderWithProviders(<ReportNotices />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders every notice in order inside a status region', () => {
    renderWithProviders(<ReportNotices notices={[
      { severity: 'info', text: 'Computed from the crawl of 1 Sep.' },
      { severity: 'warning', text: 'Sign-in activity was never measured.' },
    ]} />);
    const region = screen.getByRole('status');
    const paragraphs = region.querySelectorAll('p');
    expect([...paragraphs].map((p) => p.textContent)).toEqual([
      'Computed from the crawl of 1 Sep.',
      'Sign-in activity was never measured.',
    ]);
  });

  it('styles a warning amber and an info notice blue', () => {
    renderWithProviders(<ReportNotices notices={[
      { severity: 'warning', text: 'Stale data' },
      { severity: 'info', text: 'Just so you know' },
    ]} />);
    const warning = screen.getByText('Stale data');
    const info = screen.getByText('Just so you know');
    expect(warning).toHaveClass('bg-amber-50', 'text-amber-800');
    expect(warning).not.toHaveClass('bg-blue-50');
    expect(info).toHaveClass('bg-blue-50', 'text-blue-800');
    expect(info).not.toHaveClass('bg-amber-50');
  });

  it('falls back to the info style for an unknown or missing severity', () => {
    renderWithProviders(<ReportNotices notices={[
      { severity: 'critical', text: 'Unknown severity' },
      { text: 'No severity' },
    ]} />);
    for (const text of ['Unknown severity', 'No severity']) {
      const el = screen.getByText(text);
      expect(el).toHaveClass('bg-blue-50', 'text-blue-800');
      expect(el.className).not.toContain('undefined');
    }
  });
});
