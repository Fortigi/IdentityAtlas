// @vitest-environment jsdom
//
// Mount tests for the sharer's flow (#1166) — the permission-gated button and
// the create-then-copy dialog.

import { describe, it, expect, vi } from 'vitest';
import ShareMatrixButton from './ShareMatrixButton';
import ShareMatrixDialog from './ShareMatrixDialog';
import { buildShareUrl } from '@ui/App.helpers';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const FILTER = { rowType: 'user', subject: { include: [{ column: 'department', values: ['Sales'] }] } };
const sharer = { permissions: new Set(['data.share']), hasWildcard: false, permissionsLoaded: true };
const reader = { permissions: new Set(['data.read']), hasWildcard: false, permissionsLoaded: true };

describe('ShareMatrixButton', () => {
  it('offers sharing to a user with data.share', () => {
    renderWithProviders(<ShareMatrixButton filter={FILTER} managed="all" />, { auth: sharer });
    expect(screen.getByRole('button', { name: /Share view/i })).toBeInTheDocument();
  });

  it('renders nothing without the permission — no door that would 403', () => {
    renderWithProviders(<ShareMatrixButton filter={FILTER} managed="all" />, { auth: reader });
    expect(screen.queryByRole('button', { name: /Share view/i })).not.toBeInTheDocument();
  });

  it('renders nothing when there is no matrix to share yet', () => {
    renderWithProviders(<ShareMatrixButton filter={null} managed="all" />, { auth: sharer });
    expect(screen.queryByRole('button', { name: /Share view/i })).not.toBeInTheDocument();
  });

  it('opens the dialog on click', async () => {
    renderWithProviders(<ShareMatrixButton filter={FILTER} managed="all" />, { auth: sharer });
    await userEvent.setup().click(screen.getByRole('button', { name: /Share view/i }));
    expect(screen.getByText('Share this matrix')).toBeInTheDocument();
  });
});

describe('ShareMatrixDialog', () => {
  function open({ managed = 'gaps', filter = FILTER, response } = {}) {
    const authFetch = makeAuthFetch({ '/api/matrix/shares': response ?? { token: 'fgs_secrettoken' } });
    const onClose = vi.fn();
    renderWithProviders(<ShareMatrixDialog filter={filter} managed={managed} onClose={onClose} />, {
      auth: { ...sharer, authFetch },
    });
    return { authFetch, onClose, user: userEvent.setup() };
  }

  it('refuses to create an unnamed share', async () => {
    const { authFetch } = open();
    expect(screen.getByRole('button', { name: /Create link/i })).toBeDisabled();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('posts the snapshot — filter, managed toggle and display mode', async () => {
    const { authFetch, user } = open({ managed: 'gaps' });
    await user.type(screen.getByRole('textbox', { name: /Name this view/i }), 'Sales team access');
    await user.click(screen.getByRole('button', { name: /Create link/i }));

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    const [url, opts] = authFetch.mock.calls[0];
    expect(url).toBe('/api/matrix/shares');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      name: 'Sales team access',
      filter: FILTER,
      managed: 'gaps',
      displayMode: 'grid',
    });
  });

  it('records the rotated display mode when that is what the sharer was viewing', async () => {
    const rotated = { ...FILTER, orientation: 'rows-as-subjects' };
    const { authFetch, user } = open({ filter: rotated });
    await user.type(screen.getByRole('textbox', { name: /Name this view/i }), 'Rotated view');
    await user.click(screen.getByRole('button', { name: /Create link/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    expect(JSON.parse(authFetch.mock.calls[0][1].body).displayMode).toBe('rotated');
  });

  it('shows the fragment link once and copies it', async () => {
    const { user } = open();
    await user.type(screen.getByRole('textbox', { name: /Name this view/i }), 'Sales team access');
    await user.click(screen.getByRole('button', { name: /Create link/i }));

    const expected = buildShareUrl('fgs_secrettoken');
    expect(await screen.findByText(expected)).toBeInTheDocument();
    // The token rides in the fragment, so it can never reach a server log.
    expect(expected).toContain('#shared:fgs_secrettoken');
    expect(expected.split('#')[0]).not.toContain('fgs_');
    // The name field is gone — the share exists now and can't be re-created here.
    expect(screen.queryByRole('textbox', { name: /Name this view/i })).not.toBeInTheDocument();

    // userEvent installs a real clipboard stub, so read back what landed there
    // — and CopyButton only says "copied" when the write actually resolved.
    await user.click(screen.getByRole('button', { name: /Copy link/i }));
    expect(await screen.findByRole('button', { name: /Link copied/i })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(expected);
  });

  it('reports a failed create and keeps the form open to retry', async () => {
    const { user, onClose } = open({ response: jsonResponse({ error: 'Insufficient permissions' }, { ok: false, status: 403 }) });
    await user.type(screen.getByRole('textbox', { name: /Name this view/i }), 'Sales team access');
    await user.click(screen.getByRole('button', { name: /Create link/i }));

    expect(await screen.findByText('Insufficient permissions')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Name this view/i })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Cancel without creating anything', async () => {
    const { user, onClose, authFetch } = open();
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(authFetch).not.toHaveBeenCalled();
  });
});
