// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import UpdatesSettings from './UpdatesSettings';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const statusAvailable = {
  channel: 'edge',
  currentVersion: '5.310.20260629.1221',
  autoUpdateEnabled: false,
  updateAvailable: true,
  latestVersion: '5.324.20260630.0743',
  lastCheck: {
    id: 9, status: 'available', channel: 'edge',
    currentVersion: '5.310.20260629.1221', latestVersion: '5.324.20260630.0743',
    updateAvailable: true, createdAt: '2026-06-30T07:00:00Z', source: 'scheduler',
  },
  components: {
    web: { version: '5.310.20260629.1221' },
    worker: { version: '5.310.20260629.1221', lastSeenAt: '2026-06-30T07:00:00Z', stale: false },
    database: { version: '5.310.20260629.1221', mismatch: false, ahead: false },
  },
  skew: { mismatch: false, workerStale: false, workerKnown: true },
  applyStalled: false,
};

const logData = {
  data: [
    { id: 9, status: 'available', channel: 'edge', currentVersion: '5.310.20260629.1221', latestVersion: '5.324.20260630.0743', createdAt: '2026-06-30T07:00:00Z', source: 'scheduler' },
    { id: 8, status: 'installed', channel: 'edge', currentVersion: '5.300.20260620.0900', latestVersion: '5.310.20260629.1221', createdAt: '2026-06-29T07:00:00Z', source: 'auto-detected' },
  ],
};

function fetchFor(status = statusAvailable, log = logData) {
  return makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    const m = opts.method || 'GET';
    if (u.includes('/api/admin/updates/status')) return status;
    if (u.includes('/api/admin/updates/log')) return log;
    if (u.includes('/api/admin/updates/auto') && m === 'PUT') {
      return jsonResponse({ autoUpdateEnabled: JSON.parse(opts.body).enabled });
    }
    if (u.includes('/api/admin/updates/check') && m === 'POST') {
      return jsonResponse({ status: 'available', updateAvailable: true });
    }
    return jsonResponse({ error: 'not stubbed' }, { ok: false, status: 404 });
  });
}

describe('UpdatesSettings (mounted)', () => {
  it('shows web + worker versions matched, an available badge, and the history', async () => {
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch: fetchFor() } });
    await screen.findByText('Check now');
    // Web + worker both on 5.310 → the version appears more than once, plus a Matched badge.
    expect(screen.getAllByText('5.310.20260629.1221').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Matched').length).toBeGreaterThan(0); // worker + database
    expect(screen.getAllByText('edge').length).toBeGreaterThan(0);
    expect(screen.getByText(/Update available:/i)).toBeInTheDocument();
    expect(screen.getAllByText('5.324.20260630.0743').length).toBeGreaterThan(0);
    expect(screen.getByText('installed')).toBeInTheDocument();
    expect(screen.getByText('5.300.20260620.0900 → 5.310.20260629.1221')).toBeInTheDocument();
  });

  it('shows "Up to date" when no update is available', async () => {
    const s = { ...statusAvailable, updateAvailable: false, lastCheck: { ...statusAvailable.lastCheck, status: 'up-to-date', updateAvailable: false } };
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch: fetchFor(s) } });
    // Both the availability badge and the database badge read "Up to date" here.
    expect((await screen.findAllByText('Up to date')).length).toBeGreaterThan(0);
  });

  it('flags web/worker version skew with a Mismatch badge and a banner', async () => {
    const s = {
      ...statusAvailable,
      components: { web: { version: '5.310.20260629.1221' }, worker: { version: '5.309.20260628.1000', lastSeenAt: '2026-06-30T07:00:00Z', stale: false } },
      skew: { mismatch: true, workerStale: false, workerKnown: true },
    };
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch: fetchFor(s) } });
    expect(await screen.findByText('Mismatch')).toBeInTheDocument();
    expect(screen.getByText(/running different versions/i)).toBeInTheDocument();
    // 5.309 appears in the worker row and again in the mismatch banner.
    expect(screen.getAllByText('5.309.20260628.1000').length).toBeGreaterThan(0);
  });

  it('warns when auto-update is on but nothing is installing (applyStalled)', async () => {
    const s = { ...statusAvailable, autoUpdateEnabled: true, applyStalled: true };
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch: fetchFor(s) } });
    expect(await screen.findByText(/nothing is installing them/i)).toBeInTheDocument();
  });

  it('shows "not reported yet" when the worker has never checked in', async () => {
    const s = {
      ...statusAvailable,
      components: { web: { version: '5.310.20260629.1221' }, worker: { version: null, lastSeenAt: null, stale: false } },
      skew: { mismatch: false, workerStale: false, workerKnown: false },
    };
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch: fetchFor(s) } });
    expect(await screen.findByText('not reported yet')).toBeInTheDocument();
  });

  it('shows the database version, matched to web', async () => {
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch: fetchFor() } });
    expect(await screen.findByText('Database')).toBeInTheDocument();
    // Web, worker, and database all on 5.310 → the version string appears several times…
    expect(screen.getAllByText('5.310.20260629.1221').length).toBeGreaterThan(2);
    // …and both worker and database show a Matched badge.
    expect(screen.getAllByText('Matched').length).toBeGreaterThan(1);
  });

  it('warns when the database schema is ahead of the running app', async () => {
    const s = {
      ...statusAvailable,
      components: { ...statusAvailable.components, database: { version: '5.999.20260707.0000', mismatch: true, ahead: true } },
    };
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch: fetchFor(s) } });
    expect(await screen.findByText(/database schema is newer/i)).toBeInTheDocument();
    // The stamped DB version appears in the row and again in the banner.
    expect(screen.getAllByText('5.999.20260707.0000').length).toBeGreaterThan(0);
  });

  it('states honestly that the app never installs updates itself', async () => {
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch: fetchFor() } });
    // The honest wording appears in both the intro and the toggle copy.
    expect((await screen.findAllByText(/never installs updates itself/i)).length).toBeGreaterThan(0);
  });

  it('enables automatic updates via the switch', async () => {
    const authFetch = fetchFor();
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch } });
    const user = userEvent.setup();
    const sw = await screen.findByRole('switch');
    expect(sw).not.toBeChecked();
    await user.click(sw);
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith('/api/admin/updates/auto', expect.objectContaining({ method: 'PUT' }))
    );
    expect(sw).toBeChecked();
  });

  it('runs a check now and reloads status', async () => {
    const authFetch = fetchFor();
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch } });
    const user = userEvent.setup();
    await screen.findByText('Check now');
    authFetch.mockClear();
    await user.click(screen.getByText('Check now'));
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith('/api/admin/updates/check', expect.objectContaining({ method: 'POST' }))
    );
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/admin/updates/status'));
  });

  it('disables the switch and shows a pinned badge for pinned deployments', async () => {
    const s = { channel: 'pinned', currentVersion: '5.2.1.0', autoUpdateEnabled: false, updateAvailable: false, lastCheck: { id: 1, status: 'checked', channel: 'pinned', createdAt: '2026-06-30T07:00:00Z' } };
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch: fetchFor(s, { data: [] }) } });
    expect(await screen.findByText(/Pinned — auto-update not applicable/i)).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('shows an error when the status load fails', async () => {
    const authFetch = makeAuthFetch(async () => { throw new Error('boom'); });
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch } });
    expect(await screen.findByText('Failed to load update status.')).toBeInTheDocument();
  });
});
