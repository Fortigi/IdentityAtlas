// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import DashboardTrendsTab from './DashboardTrendsTab';
import { renderWithProviders, jsonResponse, screen } from '@ui/test-utils/renderWithProviders';

// The Trends tab's loading/error branches were only covered incidentally (and
// flakily) via DashboardPage.mount.test's tab-switch timing. Cover all three
// states deterministically here so the file's line coverage doesn't wobble.
describe('DashboardTrendsTab (mounted)', () => {
  it('shows the loading state until the snapshot resolves', () => {
    const authFetch = () => new Promise(() => {}); // never resolves → stays loading
    renderWithProviders(h(DashboardTrendsTab), { auth: { authFetch } });
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it('renders the charts + headline % once the snapshot resolves', async () => {
    const authFetch = () => Promise.resolve(jsonResponse({
      data: [
        { date: '2026-05-01', principals: 1000, resources: 400, assignments: 5000, governedAssignments: 2500 },
        { date: '2026-06-01', principals: 1200, resources: 450, assignments: 5400, governedAssignments: 2700 },
      ],
    }));
    renderWithProviders(h(DashboardTrendsTab), { auth: { authFetch } });
    expect(await screen.findByText('Governed assignments — % of total')).toBeInTheDocument();
    expect(screen.getByText('today')).toBeInTheDocument();               // latest headline block
    expect(screen.getByText('Users (principals)')).toBeInTheDocument();  // per-principal chart title
  });

  it('shows an error state when the snapshot fetch fails', async () => {
    const authFetch = () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    renderWithProviders(h(DashboardTrendsTab), { auth: { authFetch } });
    expect(await screen.findByText(/Failed to load/i)).toBeInTheDocument();
  });
});
