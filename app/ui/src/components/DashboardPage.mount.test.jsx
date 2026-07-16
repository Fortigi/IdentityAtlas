// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import DashboardPage from './DashboardPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const fullStats = {
  hasData: true,
  systems: 3,
  principals: 1200,
  resources: 450,
  businessRoles: 12,
  identities: 1100,
  contexts: 8,
  assignments: 5400,
  relationships: 320,
  identityMembers: 1300,
  syncLogEntries: 42,
  lastSyncAt: '2026-06-01T10:00:00Z',
  activeClassifiers: 1,
  llmConfigured: true,
  riskScores: 900,
  certifications: 5,
  enabledCrawlers: 2,
  runningJobs: 1,
};

const version = { version: '5.3.20260419.1430' };

function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/admin/dashboard-stats': fullStats,
    '/api/version': version,
    ...overrides,
  });
}

describe('DashboardPage (mounted)', () => {
  it('renders stat cards and feature status after load', async () => {
    const onNavigate = vi.fn();
    renderWithProviders(h(DashboardPage, { onNavigate }), { auth: { authFetch: routes() } });

    // Stat grid populates only after the dashboard-stats fetch resolves.
    // "Business Roles" and "Identity Members" are unique to the stat cards
    // (the BrainGraph SVG uses the shorter "Roles" / "ID Members" labels).
    expect(await screen.findByText('Business Roles')).toBeInTheDocument();
    expect(screen.getByText('Identity Members')).toBeInTheDocument();
    expect(screen.getByText('Loaded data')).toBeInTheDocument();

    // Feature status row (hasData true).
    expect(screen.getByText('Risk Scoring')).toBeInTheDocument();
    expect(screen.getByText('Certifications')).toBeInTheDocument();
    expect(screen.getByText('Crawlers')).toBeInTheDocument();

    // Version card rendered from /api/version.
    expect(screen.getByText('v5.3.20260419.1430')).toBeInTheDocument();
  });

  it('links the marketing website from the Resources card', async () => {
    renderWithProviders(h(DashboardPage), { auth: { authFetch: routes() } });
    const link = await screen.findByRole('link', { name: /Website/i });
    expect(link).toHaveAttribute('href', 'https://identityatlas.io');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('links Contribute and Report-an-issue to the version-matched docs pages', async () => {
    // version 5.3.20260419.1430 is an edge build (8-digit 3rd segment) → /edge/ docs alias.
    renderWithProviders(h(DashboardPage), { auth: { authFetch: routes() } });

    const contribute = await screen.findByRole('link', { name: /Contribute/i });
    expect(contribute).toHaveAttribute(
      'href',
      'https://fortigi.github.io/IdentityAtlas/edge/contributing/contribute/',
    );

    const report = screen.getByRole('link', { name: /Report an issue or feature request/i });
    expect(report).toHaveAttribute(
      'href',
      'https://fortigi.github.io/IdentityAtlas/edge/contributing/report-an-issue/',
    );

    // The support email was intentionally removed from the dashboard — support
    // now routes through the report-an-issue guide (which covers SLAs), not a
    // mailto on the solution home page.
    expect(screen.queryByText(/support@identityatlas\.io/i)).toBeNull();
  });

  it('navigates when a populated stat card is clicked', async () => {
    const onNavigate = vi.fn();
    renderWithProviders(h(DashboardPage, { onNavigate }), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    // "Business Roles" is unique to the stat card; click its label — the
    // onClick handler lives on the enclosing card div.
    await user.click(await screen.findByText('Business Roles'));
    expect(onNavigate).toHaveBeenCalledWith('access-packages');

    await user.click(screen.getByText(/sync log entries/i));
    expect(onNavigate).toHaveBeenCalledWith('sync-log');

    // "Principals" appears on both the stat card and the SVG brain-graph node;
    // click the stat-card one (not inside the <svg>) — it routes to the tab.
    const principals = screen.getAllByText('Principals').find(el => !el.closest('svg'));
    await user.click(principals);
    expect(onNavigate).toHaveBeenCalledWith('principals');
  });

  it('shows the no-data onboarding CTA when the database is empty', async () => {
    const onNavigate = vi.fn();
    renderWithProviders(h(DashboardPage, { onNavigate }), {
      auth: { authFetch: routes({ '/api/admin/dashboard-stats': { hasData: false } }) },
    });
    const user = userEvent.setup();

    expect(await screen.findByText(/No data loaded yet/i)).toBeInTheDocument();
    await user.click(screen.getByText(/Configure a crawler/i));
    expect(onNavigate).toHaveBeenCalledWith('admin');
  });

  it('shows a load error (not the empty state) when stats fetch fails', async () => {
    renderWithProviders(h(DashboardPage), {
      auth: {
        authFetch: routes({
          '/api/admin/dashboard-stats': jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
        }),
      },
    });

    expect(await screen.findByText(/Couldn.t load the dashboard/i)).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
    // The onboarding CTA must NOT appear on a load error.
    expect(screen.queryByText(/No data loaded yet/i)).not.toBeInTheDocument();
  });

  it('retries the stats fetch when the Retry button is clicked', async () => {
    // First stats call fails; after Retry it succeeds — the error UI gives way
    // to the populated dashboard.
    let statsCalls = 0;
    const authFetch = vi.fn((url) => {
      if (url.startsWith('/api/admin/dashboard-stats')) {
        statsCalls += 1;
        return Promise.resolve(
          statsCalls === 1 ? jsonResponse({ error: 'boom' }, { ok: false, status: 500 }) : jsonResponse(fullStats),
        );
      }
      if (url.startsWith('/api/version')) return Promise.resolve(jsonResponse(version));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(h(DashboardPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await user.click(await screen.findByText('Retry'));

    expect(await screen.findByText('Business Roles')).toBeInTheDocument();
    expect(statsCalls).toBe(2);
  });

  it('switches to the Trends tab and loads the timeseries snapshot', async () => {
    const timeseries = {
      data: [
        { date: '2026-05-01', principals: 1000, resources: 400, assignments: 5000, governedAssignments: 2500 },
        { date: '2026-06-01', principals: 1200, resources: 450, assignments: 5400, governedAssignments: 2700 },
      ],
    };
    const authFetch = routes({ '/api/admin/dashboard-timeseries': timeseries });
    renderWithProviders(h(DashboardPage), { auth: { authFetch } });
    const user = userEvent.setup();

    // Wait for the overview to settle, then switch tabs.
    await screen.findByText('Business Roles');
    await user.click(screen.getByRole('tab', { name: 'Trends' }));

    // The lazy DashboardTrendsTab mounts and fetches the snapshot endpoint.
    expect(await screen.findByText(/Governed assignments — % of total/i)).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('/api/admin/dashboard-timeseries'));
  });
});
