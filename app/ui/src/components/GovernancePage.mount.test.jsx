// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import GovernancePage from './GovernancePage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const summary = { totalAPs: 10, compliant: 6, overdue: 2, reviewedLate: 1, inProgress: 1 };
const categories = [{ id: 'c1', name: 'Finance' }];
const complianceRows = [
  {
    accessPackageId: 'ap1',
    accessPackageName: 'Payroll Access',
    catalogName: 'HR Catalog',
    categoryName: 'Finance',
    categoryColor: '#ff0000',
    complianceStatus: 'Overdue',
    deadline: '2026-01-01T00:00:00Z',
    daysOverdue: 30,
    totalDecisions: 5,
    notReviewed: 2,
    lastReviewedBy: 'alice',
  },
];

function routes(overrides = {}) {
  return makeAuthFetch({
    'governance/summary': summary,
    'governance/categories': categories,
    'governance/review-compliance': complianceRows,
    ...overrides,
  });
}

describe('GovernancePage (mounted)', () => {
  it('renders the compliance summary cards after load', async () => {
    renderWithProviders(h(GovernancePage), { auth: { authFetch: routes() } });

    expect(await screen.findByText('Certification Compliance')).toBeInTheDocument();
    expect(screen.getByText('Business Roles')).toBeInTheDocument();
    // compliantPct = 60% on time
    expect(screen.getByText('60% on time')).toBeInTheDocument();
    // category filter built from the categories fetch
    expect(screen.getByRole('option', { name: 'Finance' })).toBeInTheDocument();
  });

  it('shows an error panel when the summary fetch fails', async () => {
    renderWithProviders(h(GovernancePage), {
      auth: { authFetch: routes({ 'governance/summary': jsonResponse({}, { ok: false, status: 503 }) }) },
    });
    expect(await screen.findByText('Error loading certification data')).toBeInTheDocument();
    expect(screen.getByText('HTTP 503')).toBeInTheDocument();
  });

  it('drills down into a compliance bucket when a stat tile is clicked', async () => {
    const authFetch = routes();
    renderWithProviders(h(GovernancePage), { auth: { authFetch } });
    const user = userEvent.setup();

    // The "Overdue" card is clickable because overdue > 0.
    await user.click(await screen.findByRole('button', { name: /deadline passed/i }));

    expect(await screen.findByText('Payroll Access')).toBeInTheDocument();
    expect(screen.getByText('HR Catalog')).toBeInTheDocument();
    expect(screen.getByText('30d')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('filter=overdue'));
  });

  it('re-queries the drilldown when the category filter changes', async () => {
    const authFetch = routes();
    renderWithProviders(h(GovernancePage), { auth: { authFetch } });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /deadline passed/i }));
    await screen.findByText('Payroll Access');

    await user.selectOptions(screen.getByRole('combobox'), 'c1');
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('category=c1'));
  });
});
