// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import UpdatesSettings from './UpdatesSettings';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const statusAvailable = {
  channel: 'edge',
  currentVersion: '5.310.20260629.1221',
  autoUpdateEnabled: false,
  lastCheck: {
    id: 9, status: 'available', channel: 'edge',
    currentVersion: '5.310.20260629.1221', latestVersion: '5.324.20260630.0743',
    updateAvailable: true, createdAt: '2026-06-30T07:00:00Z', source: 'scheduler',
  },
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
  it('shows current version, channel, an available badge, and the history', async () => {
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch: fetchFor() } });
    expect(await screen.findByText('5.310.20260629.1221')).toBeInTheDocument();
    expect(screen.getAllByText('edge').length).toBeGreaterThan(0);
    expect(screen.getByText(/Update available:/i)).toBeInTheDocument();
    expect(screen.getAllByText('5.324.20260630.0743').length).toBeGreaterThan(0);
    expect(screen.getByText('installed')).toBeInTheDocument();
    expect(screen.getByText('5.300.20260620.0900 → 5.310.20260629.1221')).toBeInTheDocument();
  });

  it('shows "Up to date" when no update is available', async () => {
    const s = { ...statusAvailable, lastCheck: { ...statusAvailable.lastCheck, status: 'up-to-date', updateAvailable: false } };
    renderWithProviders(h(UpdatesSettings), { auth: { authFetch: fetchFor(s) } });
    expect(await screen.findByText('Up to date')).toBeInTheDocument();
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
    await screen.findByText('5.310.20260629.1221');
    authFetch.mockClear();
    await user.click(screen.getByText('Check now'));
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith('/api/admin/updates/check', expect.objectContaining({ method: 'POST' }))
    );
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/admin/updates/status'));
  });

  it('disables the switch and shows a pinned badge for pinned deployments', async () => {
    const s = { channel: 'pinned', currentVersion: '5.2.1.0', autoUpdateEnabled: false, lastCheck: { id: 1, status: 'checked', channel: 'pinned', createdAt: '2026-06-30T07:00:00Z' } };
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
