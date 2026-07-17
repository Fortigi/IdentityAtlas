// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import SyncLogPage from './SyncLogPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const crawlerLogs = [
  {
    Id: 1,
    SyncType: 'EntraGroups',
    TableName: 'Resources',
    RecordCount: 1234,
    Status: 'Success',
    StartTime: '2026-06-02T10:00:00Z',
  },
  {
    Id: 2,
    SyncType: 'EntraUsers',
    TableName: 'Principals',
    RecordCount: 5678,
    Status: 'Failed',
    StartTime: '2026-06-01T10:00:00Z',
  },
];

const pluginRuns = {
  data: [
    {
      id: 10,
      algorithmDisplayName: 'Manager Hierarchy',
      parameters: { rootName: 'Org Chart' },
      status: 'succeeded',
      startedAt: '2026-06-03T10:00:00Z',
      triggeredBy: 'system',
    },
  ],
};

const linkRuns = [
  {
    id: 20,
    step: 'matching accounts',
    status: 'running',
    startedAt: '2026-06-04T10:00:00Z',
    triggeredBy: 'alice',
  },
];

const riskRuns = [
  {
    id: 30,
    scoredEntities: 90,
    totalEntities: 100,
    status: 'completed',
    startedAt: '2026-06-05T10:00:00Z',
    triggeredBy: 'bob',
  },
];

function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/sync-log': crawlerLogs,
    '/api/context-plugins/runs': pluginRuns,
    '/api/account-linking/runs': linkRuns,
    '/api/risk-scoring/runs': riskRuns,
    ...overrides,
  });
}

describe('SyncLogPage (mounted)', () => {
  it('merges all four sources into one activity stream after load', async () => {
    renderWithProviders(h(SyncLogPage), { auth: { authFetch: routes() } });

    // Rows populate only after the mount-effect fetches resolve.
    expect(await screen.findByText('EntraGroups')).toBeInTheDocument();
    expect(screen.getByText('EntraUsers')).toBeInTheDocument();
    expect(screen.getByText('Manager Hierarchy')).toBeInTheDocument();
    // 'Account linking' is both a chip label and a row title — at least one match.
    expect(screen.getAllByText('Account linking').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Risk scoring').length).toBeGreaterThan(0);

    // Status badges from the various sources.
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('filters rows by kind when a chip is clicked', async () => {
    renderWithProviders(h(SyncLogPage), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('EntraGroups');

    // Switch to the Plugin runs bucket — crawler rows disappear.
    await user.click(screen.getByRole('button', { name: /Plugin runs/i }));
    expect(screen.getByText('Manager Hierarchy')).toBeInTheDocument();
    expect(screen.queryByText('EntraGroups')).not.toBeInTheDocument();
  });

  it('filters rows by the free-text search box', async () => {
    renderWithProviders(h(SyncLogPage), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('EntraGroups');

    // Reachable by accessible name (aria-label), not just placeholder — #761.
    await user.type(screen.getByRole('textbox', { name: /Filter sync log/i }), 'EntraUsers');
    expect(screen.getByText('EntraUsers')).toBeInTheDocument();
    expect(screen.queryByText('EntraGroups')).not.toBeInTheDocument();
  });

  it('shows the empty state when no entries match', async () => {
    renderWithProviders(h(SyncLogPage), {
      auth: {
        authFetch: routes({
          '/api/sync-log': [],
          '/api/context-plugins/runs': { data: [] },
          '/api/account-linking/runs': [],
          '/api/risk-scoring/runs': [],
        }),
      },
    });

    expect(await screen.findByText(/No log entries match/i)).toBeInTheDocument();
  });

  it('surfaces a load error when the sync-log fetch fails', async () => {
    renderWithProviders(h(SyncLogPage), {
      auth: {
        authFetch: routes({
          '/api/sync-log': jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
        }),
      },
    });

    expect(await screen.findByText(/Failed to load: HTTP 500/i)).toBeInTheDocument();
  });

  it('navigates back to the source when a row Source link is clicked', async () => {
    const navigate = vi.fn();
    renderWithProviders(h(SyncLogPage, { navigate }), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('EntraGroups');

    await user.click(screen.getAllByRole('button', { name: /Crawlers →/i })[0]);
    expect(navigate).toHaveBeenCalledWith('admin?sub=crawlers');
  });
});
