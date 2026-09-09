// @vitest-environment jsdom
//
// Mount tests for the Shared matrices management page (#1166, AC12) — now an
// Admin sub-tab, and now showing WHO each share was addressed to alongside who
// actually opened it.

import { describe, it, expect, vi } from 'vitest';
import SharedMatricesPage from './SharedMatricesPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const SHARES = [
  {
    id: 'share-used',
    name: 'Sales team access',
    createdBy: 'analyst@example.com',
    createdAt: '2026-09-01T09:00:00Z',
    revokedAt: null,
    revokedBy: null,
    accessCount: 3,
    userCount: 2,
    recipients: [
      { userKey: 'manager@example.com', displayName: 'Ann Manager' },
      { userKey: 'owner@example.com', displayName: 'Owen Owner' },
      { userKey: 'never@example.com', displayName: 'Nev Never' },
    ],
    usage: [
      { userKey: 'manager@example.com', accessCount: 2, firstAccessAt: '2026-09-02T09:00:00Z', lastAccessAt: '2026-09-05T09:00:00Z' },
      { userKey: 'owner@example.com', accessCount: 1, firstAccessAt: '2026-09-03T09:00:00Z', lastAccessAt: '2026-09-03T09:00:00Z' },
    ],
  },
  {
    id: 'share-unused',
    name: 'Payroll app owners',
    createdBy: 'analyst@example.com',
    createdAt: '2026-09-04T09:00:00Z',
    revokedAt: null,
    accessCount: 0,
    userCount: 0,
    recipients: [{ userKey: 'payroll.owner@example.com', displayName: 'Pat Payroll' }],
    usage: [],
  },
  {
    id: 'share-revoked',
    name: 'Old contractor view',
    createdBy: 'other@example.com',
    createdAt: '2026-08-01T09:00:00Z',
    revokedAt: '2026-08-20T09:00:00Z',
    revokedBy: 'admin@example.com',
    accessCount: 1,
    userCount: 1,
    // A share created before named recipients existed.
    recipients: [],
    usage: [{ userKey: 'temp@example.com', accessCount: 1, firstAccessAt: '2026-08-02T09:00:00Z', lastAccessAt: '2026-08-02T09:00:00Z' }],
  },
];

const sharer = { permissions: new Set(['data.share']), hasWildcard: false, permissionsLoaded: true };

function rowFor(name) {
  return screen.getByText(name).closest('tr');
}

describe('SharedMatricesPage', () => {
  it('lists every share org-wide with sharer, usage and status', async () => {
    const authFetch = makeAuthFetch({ '/api/matrix/shares': SHARES });
    renderWithProviders(<SharedMatricesPage />, { auth: { ...sharer, authFetch } });

    expect(await screen.findByText('Sales team access')).toBeInTheDocument();

    const used = rowFor('Sales team access');
    expect(within(used).getByText('manager@example.com')).toBeInTheDocument();
    expect(within(used).getByText('owner@example.com')).toBeInTheDocument();
    expect(within(used).getByText(/3 views in total/)).toBeInTheDocument();
    expect(within(used).getByText('Active')).toBeInTheDocument();

    // Shares from other analysts are listed too — visibility is org-wide.
    expect(within(rowFor('Old contractor view')).getByText('other@example.com')).toBeInTheDocument();
  });

  it('separates who a share was FOR from who actually opened it (#1166)', async () => {
    const authFetch = makeAuthFetch({ '/api/matrix/shares': SHARES });
    renderWithProviders(<SharedMatricesPage />, { auth: { ...sharer, authFetch } });
    await screen.findByText('Sales team access');

    const used = rowFor('Sales team access');
    // Three people were named; only two of them ever opened it. That gap is
    // the reason both columns exist — an "opened by" list alone can't show it.
    expect(within(used).getByText('Nev Never')).toBeInTheDocument();
    expect(within(used).getByText('Ann Manager')).toBeInTheDocument();
    expect(within(used).queryByText('never@example.com')).not.toBeInTheDocument();
    expect(within(used).getByText('manager@example.com')).toBeInTheDocument();

    // A share from before named recipients existed says what it is, rather
    // than rendering a blank that reads as "shared with nobody".
    expect(within(rowFor('Old contractor view')).getByText('Anyone with the link')).toBeInTheDocument();
  });

  it('makes a never-opened share obvious and offers no revoke on a revoked one', async () => {
    const authFetch = makeAuthFetch({ '/api/matrix/shares': SHARES });
    renderWithProviders(<SharedMatricesPage />, { auth: { ...sharer, authFetch } });
    await screen.findByText('Payroll app owners');

    const unused = rowFor('Payroll app owners');
    expect(within(unused).getByText('Never opened')).toBeInTheDocument();
    expect(within(unused).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();

    const revoked = rowFor('Old contractor view');
    expect(within(revoked).getByText('Revoked')).toBeInTheDocument();
    expect(within(revoked).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    // Usage history survives revocation.
    expect(within(revoked).getByText('temp@example.com')).toBeInTheDocument();
  });

  it('revokes through a confirm dialog and reloads the list', async () => {
    const user = userEvent.setup();
    const revoke = vi.fn(async () => jsonResponse({ id: 'share-unused' }));
    const authFetch = makeAuthFetch((url, opts) => {
      if (url.includes('/revoke')) return revoke(url, opts);
      return SHARES;
    });
    renderWithProviders(<SharedMatricesPage />, { auth: { ...sharer, authFetch } });
    await screen.findByText('Payroll app owners');

    await user.click(within(rowFor('Payroll app owners')).getByRole('button', { name: 'Revoke' }));
    // A confirm dialog stands between the click and the call.
    expect(await screen.findByText(/Anyone who opens the link for "Payroll app owners"/)).toBeInTheDocument();
    expect(revoke).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    expect(revoke.mock.calls[0][0]).toBe('/api/matrix/shares/share-unused/revoke');
    expect(revoke.mock.calls[0][1].method).toBe('POST');
    // The list is re-read so the row flips to Revoked.
    await waitFor(() => expect(authFetch.mock.calls.filter(c => c[0] === '/api/matrix/shares')).toHaveLength(2));
  });

  it('does not call the API when the confirm is cancelled', async () => {
    const user = userEvent.setup();
    const revoke = vi.fn(async () => jsonResponse({}));
    const authFetch = makeAuthFetch((url, opts) => (url.includes('/revoke') ? revoke(url, opts) : SHARES));
    renderWithProviders(<SharedMatricesPage />, { auth: { ...sharer, authFetch } });
    await screen.findByText('Payroll app owners');

    await user.click(within(rowFor('Payroll app owners')).getByRole('button', { name: 'Revoke' }));
    await user.click(await screen.findByRole('button', { name: /Cancel/i }));
    expect(revoke).not.toHaveBeenCalled();
  });

  it('shows an empty state when nothing has been shared', async () => {
    const authFetch = makeAuthFetch({ '/api/matrix/shares': [] });
    renderWithProviders(<SharedMatricesPage />, { auth: { ...sharer, authFetch } });
    expect(await screen.findByText(/Nothing shared yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('surfaces a load failure without dropping the page', async () => {
    const authFetch = makeAuthFetch({ '/api/matrix/shares': jsonResponse({}, { ok: false, status: 500 }) });
    renderWithProviders(<SharedMatricesPage />, { auth: { ...sharer, authFetch } });
    expect(await screen.findByText(/Could not load shared matrices/i)).toBeInTheDocument();
  });

  it('tells a user without data.share why the page is empty, and asks the API for nothing', async () => {
    const authFetch = makeAuthFetch({ '/api/matrix/shares': SHARES });
    renderWithProviders(<SharedMatricesPage />, {
      auth: { permissions: new Set(['data.read']), hasWildcard: false, permissionsLoaded: true, authFetch },
    });
    expect(await screen.findByText(/don't have access to shared matrices/i)).toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalled();
  });
});
