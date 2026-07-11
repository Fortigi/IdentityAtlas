// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import DashboardTrendsTab from './DashboardTrendsTab';
import { renderWithProviders, jsonResponse, screen } from '@ui/test-utils/renderWithProviders';

// Deterministically cover the Trends tab's loading / data / error branches.
// They were otherwise only hit incidentally (and flakily) via
// DashboardPage.mount.test's tab-switch timing, so this file's line coverage
// wobbled across unrelated test runs (adding test files elsewhere could tip it
// below its floor). Pinning the three states here keeps it stable.
describe('DashboardTrendsTab states', () => {
  it('shows the loading placeholder until the snapshot resolves', () => {
    const authFetch = () => new Promise(() => {}); // never resolves → stays loading
    renderWithProviders(h(DashboardTrendsTab), { auth: { authFetch } });
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it('renders the charts and headline once data resolves', async () => {
    const authFetch = () => Promise.resolve(jsonResponse({
      data: [
        { date: '2026-05-01', principals: 1000, resources: 400, assignments: 5000, governedAssignments: 2500 },
        { date: '2026-06-01', principals: 1200, resources: 450, assignments: 5400, governedAssignments: 2700 },
      ],
    }));
    renderWithProviders(h(DashboardTrendsTab), { auth: { authFetch } });
    // The "today" headline block only renders once there is a latest snapshot.
    expect(await screen.findByText('today')).toBeInTheDocument();
    expect(screen.getByText('Governed assignments — % of total')).toBeInTheDocument();
    expect(screen.getByText('Users (principals)')).toBeInTheDocument();
  });

  it('shows an error banner when the snapshot fetch fails', async () => {
    const authFetch = () => Promise.resolve(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
    renderWithProviders(h(DashboardTrendsTab), { auth: { authFetch } });
    expect(await screen.findByText(/Failed to load/)).toBeInTheDocument();
  });
});
