// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import ComplianceStatusCell from './ComplianceStatusCell';
import { renderWithProviders, screen } from '@ui/test-utils/renderWithProviders';

function render(ap) {
  return renderWithProviders(h(ComplianceStatusCell, { ap }));
}

describe('ComplianceStatusCell', () => {
  it('renders a Compliant badge with an on-time tooltip', () => {
    render({ complianceStatus: 'Compliant', reviewDeadline: '2026-01-01T00:00:00Z' });
    const badge = screen.getByText('Compliant');
    expect(badge).toHaveAttribute('title', expect.stringContaining('Completed on time'));
  });

  it('renders a Missed badge with overdue days, reviewer and missed-review lines', () => {
    render({
      complianceStatus: 'Missed',
      daysOverdue: 12,
      reviewDeadline: '2026-02-01T00:00:00Z',
      reviewerInfo: 'bob',
      missedReviewsCount: 2,
    });
    expect(screen.getByText(/Missed/)).toHaveAttribute('title', expect.stringContaining('Review deadline passed 12 days ago'));
    expect(screen.getByText(/\(12d ago\)/)).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('2 reviews not done')).toBeInTheDocument();
  });

  it('uses singular wording for a single overdue day and a single missed review', () => {
    render({
      complianceStatus: 'Missed',
      daysOverdue: 1,
      reviewDeadline: '2026-02-01T00:00:00Z',
      missedReviewsCount: 1,
    });
    expect(screen.getByText(/Missed/)).toHaveAttribute('title', expect.stringContaining('1 day ago'));
    expect(screen.getByText('1 review not done')).toBeInTheDocument();
  });

  it('renders a Reviewed Late tooltip', () => {
    render({ complianceStatus: 'Reviewed Late', reviewDeadline: '2026-02-01T00:00:00Z' });
    expect(screen.getByText('Reviewed Late')).toHaveAttribute('title', expect.stringContaining('Reviewed after deadline'));
  });

  it('renders an In Progress badge with a due tooltip and reviewer line', () => {
    render({ complianceStatus: 'In Progress', reviewDeadline: '2026-03-01T00:00:00Z', reviewerInfo: 'carol' });
    expect(screen.getByText('In Progress')).toHaveAttribute('title', expect.stringContaining('Due'));
    expect(screen.getByText('carol')).toBeInTheDocument();
  });

  it('shows "No assignments" with the configured-review tooltip', () => {
    render({ complianceStatus: null, totalAssignments: 0, hasReviewConfigured: true });
    expect(screen.getByText('No assignments')).toHaveAttribute('title', expect.stringContaining('nothing to review'));
  });

  it('shows "No assignments" with the no-active-assignments tooltip', () => {
    render({ complianceStatus: null, totalAssignments: 0, hasReviewConfigured: false });
    expect(screen.getByText('No assignments')).toHaveAttribute('title', 'No active assignments');
  });

  it('shows "Pending first review" when a review is configured but none has run', () => {
    render({ complianceStatus: null, totalAssignments: 4, hasReviewConfigured: true, reviewerInfo: 'dave' });
    expect(screen.getByText('Pending first review')).toBeInTheDocument();
    expect(screen.getByText('dave')).toBeInTheDocument();
  });

  it('shows "Not required" when there is no configured review', () => {
    render({ complianceStatus: null, totalAssignments: 4, hasReviewConfigured: false });
    expect(screen.getByText('Not required')).toBeInTheDocument();
  });
});
