// @vitest-environment jsdom
//
// Mount tests for the sharer's flow (#1166) — the permission-gated button, the
// create form (name + named recipients) and the shown-once link, in both of
// the form's hosts: the toolbar dialog and the wizard's final step.

import { describe, it, expect, vi } from 'vitest';
import ShareMatrixButton from './ShareMatrixButton';
import ShareMatrixDialog from './ShareMatrixDialog';
import WizardShareStep from './WizardShareStep';
import { buildShareUrl } from '@ui/App.helpers';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const FILTER = { rowType: 'user', subject: { include: [{ column: 'department', values: ['Sales'] }] } };
const sharer = { permissions: new Set(['data.share']), hasWildcard: false, permissionsLoaded: true };
const reader = { permissions: new Set(['data.read']), hasWildcard: false, permissionsLoaded: true };

const ANN = { id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', displayName: 'Ann Manager', userPrincipalName: 'ann@contoso.com' };
const BOB = { id: '5c9e2a11-1111-2222-3333-444455556666', displayName: 'Bob Owner', userPrincipalName: 'bob@contoso.com' };

// The create response the API returns: the one-time token plus the recipients
// as stored (lower-cased keys).
const CREATED = {
  token: 'fgs_secrettoken',
  recipients: [{ userKey: 'ann@contoso.com', displayName: 'Ann Manager' }],
};

function stubApi(shareResponse = CREATED, people = [ANN, BOB]) {
  return makeAuthFetch({
    '/api/matrix/shares': shareResponse,
    '/api/users': { data: people },
  });
}

// Type into the people search and pick a result. The picker debounces, so the
// option only appears once the search has settled.
async function pickPerson(user, name) {
  await user.type(screen.getByRole('textbox', { name: /Share with/i }), name);
  const option = await screen.findByRole('button', { name: new RegExp(name, 'i') }, { timeout: 3000 });
  await user.click(option);
}

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
    const authFetch = stubApi(response ?? CREATED);
    const onClose = vi.fn();
    renderWithProviders(<ShareMatrixDialog filter={filter} managed={managed} onClose={onClose} />, {
      auth: { ...sharer, authFetch },
    });
    return { authFetch, onClose, user: userEvent.setup() };
  }

  it('refuses to create an unnamed share', async () => {
    const { authFetch, user } = open();
    await pickPerson(user, 'Ann Manager');
    expect(screen.getByRole('button', { name: /Create link/i })).toBeDisabled();
    expect(authFetch).not.toHaveBeenCalledWith('/api/matrix/shares', expect.anything());
  });

  it('refuses to create a share addressed to nobody — the whole point of the change', async () => {
    const { authFetch, user } = open();
    await user.type(screen.getByRole('textbox', { name: /Name this view/i }), 'Sales team access');
    // Named, but with no recipients: a link anyone could open is not offered.
    expect(screen.getByRole('button', { name: /Create link/i })).toBeDisabled();
    expect(authFetch).not.toHaveBeenCalledWith('/api/matrix/shares', expect.anything());
  });

  it('posts the snapshot and the people it is for', async () => {
    const { authFetch, user } = open({ managed: 'gaps' });
    await user.type(screen.getByRole('textbox', { name: /Name this view/i }), 'Sales team access');
    await pickPerson(user, 'Ann Manager');
    await pickPerson(user, 'Bob Owner');
    await user.click(screen.getByRole('button', { name: /Create link/i }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/matrix/shares', expect.anything()));
    const [, opts] = authFetch.mock.calls.find(([url]) => url === '/api/matrix/shares');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      name: 'Sales team access',
      filter: FILTER,
      managed: 'gaps',
      displayMode: 'grid',
      recipients: [
        { principalId: ANN.id, userKey: 'ann@contoso.com', displayName: 'Ann Manager' },
        { principalId: BOB.id, userKey: 'bob@contoso.com', displayName: 'Bob Owner' },
      ],
    });
  });

  it('records the rotated display mode when that is what the sharer was viewing', async () => {
    const rotated = { ...FILTER, orientation: 'rows-as-subjects' };
    const { authFetch, user } = open({ filter: rotated });
    await user.type(screen.getByRole('textbox', { name: /Name this view/i }), 'Rotated view');
    await pickPerson(user, 'Ann Manager');
    await user.click(screen.getByRole('button', { name: /Create link/i }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/matrix/shares', expect.anything()));
    const [, opts] = authFetch.mock.calls.find(([url]) => url === '/api/matrix/shares');
    expect(JSON.parse(opts.body).displayMode).toBe('rotated');
  });

  it('shows the fragment link once, names who it opens for, and copies it', async () => {
    const { user } = open();
    await user.type(screen.getByRole('textbox', { name: /Name this view/i }), 'Sales team access');
    await pickPerson(user, 'Ann Manager');
    await user.click(screen.getByRole('button', { name: /Create link/i }));

    const expected = buildShareUrl('fgs_secrettoken');
    expect(await screen.findByText(expected)).toBeInTheDocument();
    // The token rides in the fragment, so it can never reach a server log.
    expect(expected).toContain('#shared:fgs_secrettoken');
    expect(expected.split('#')[0]).not.toContain('fgs_');
    // The form is gone — the share exists now and can't be re-created here.
    expect(screen.queryByRole('textbox', { name: /Name this view/i })).not.toBeInTheDocument();
    // …and the sharer can see exactly who it will open for.
    const sharedWith = screen.getByRole('list', { name: /Shared with/i });
    expect(sharedWith).toHaveTextContent('Ann Manager');

    // userEvent installs a real clipboard stub, so read back what landed there
    // — and CopyButton only says "copied" when the write actually resolved.
    await user.click(screen.getByRole('button', { name: /Copy link/i }));
    expect(await screen.findByRole('button', { name: /Link copied/i })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(expected);
  });

  it('reports a failed create and keeps the form open to retry', async () => {
    const { user, onClose } = open({ response: jsonResponse({ error: 'Insufficient permissions' }, { ok: false, status: 403 }) });
    await user.type(screen.getByRole('textbox', { name: /Name this view/i }), 'Sales team access');
    await pickPerson(user, 'Ann Manager');
    await user.click(screen.getByRole('button', { name: /Create link/i }));

    expect(await screen.findByText('Insufficient permissions')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Name this view/i })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Cancel without creating anything', async () => {
    const { user, onClose, authFetch } = open();
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(authFetch).not.toHaveBeenCalledWith('/api/matrix/shares', expect.anything());
  });
});

describe('WizardShareStep', () => {
  it('offers the same share form as the wizard’s last step (#1166)', async () => {
    const authFetch = stubApi();
    renderWithProviders(<WizardShareStep filter={FILTER} managed="all" />, { auth: { ...sharer, authFetch } });
    const user = userEvent.setup();

    // Named as optional — Apply is still the ordinary way out of the wizard.
    expect(screen.getByText(/Share this matrix \(optional\)/i)).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /Name this view/i }), 'Team access');
    await pickPerson(user, 'Ann Manager');
    await user.click(screen.getByRole('button', { name: /Create link/i }));

    expect(await screen.findByText(buildShareUrl('fgs_secrettoken'))).toBeInTheDocument();
    const [, opts] = authFetch.mock.calls.find(([url]) => url === '/api/matrix/shares');
    expect(JSON.parse(opts.body).recipients).toEqual([
      { principalId: ANN.id, userKey: 'ann@contoso.com', displayName: 'Ann Manager' },
    ]);
  });
});
