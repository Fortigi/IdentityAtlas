// @vitest-environment jsdom
//
// Mount tests for the sharer's flow (#1166, reworked by #1202) — save-and-share
// under ONE name, sharing an already-saved matrix without asking for a second
// one, and the in-place management of an existing share, in both of the panel's
// hosts: the dialog the matrix bar opens and the wizard's final step.
//
// Inputs discriminate deliberately: the saved and unsaved cases are driven
// through the same component with the same clicks, so a form that asked for a
// name it already had (the #1202 complaint) fails the saved case, and one that
// dropped the name entirely fails the unsaved case.

import { describe, it, expect, vi } from 'vitest';
import ShareMatrixDialog from './ShareMatrixDialog';
import WizardShareStep from './WizardShareStep';
import { buildShareUrl } from '@ui/App.helpers';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const FILTER = { rowType: 'user', subject: { include: [{ column: 'department', values: ['Sales'] }] } };
const sharer = { permissions: new Set(['data.share']), hasWildcard: false, permissionsLoaded: true };

const SAVED_ID = '44444444-4444-4444-4444-444444444444';
const SHARE_ID = '11111111-1111-1111-1111-111111111111';

const ANN = { id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', displayName: 'Ann Manager', userPrincipalName: 'ann@contoso.com' };
const BOB = { id: '5c9e2a11-1111-2222-3333-444455556666', displayName: 'Bob Owner', userPrincipalName: 'bob@contoso.com' };

// The create response the API returns: the share row plus the address its link
// is built from, and the recipients as stored (lower-cased keys).
const CREATED = {
  id: SHARE_ID,
  shareAddress: SHARE_ID,
  savedFilterId: SAVED_ID,
  recipients: [{ userKey: 'ann@contoso.com', displayName: 'Ann Manager' }],
};

// A live share of SAVED_ID, as GET /api/matrix/shares returns it.
const LIVE_SHARE = {
  id: SHARE_ID,
  name: 'Sales team access',
  savedFilterId: SAVED_ID,
  revokedAt: null,
  recipients: [{ principalId: ANN.id, userKey: 'ann@contoso.com', displayName: 'Ann Manager' }],
};

function stubApi({ create = CREATED, shares = [], people = [ANN, BOB], recipientsPut } = {}) {
  return makeAuthFetch((url, opts) => {
    const u = String(url);
    if (u === '/api/matrix/shares' && opts?.method === 'POST') return create;
    if (u === '/api/matrix/shares') return shares;
    if (u.endsWith('/recipients')) return recipientsPut ?? { id: SHARE_ID, recipients: [] };
    if (u.endsWith('/revoke')) return { id: SHARE_ID, revokedAt: '2026-09-14T00:00:00Z' };
    if (u.startsWith('/api/users')) return { data: people };
    return undefined;
  });
}

// Type into the people search and pick a result. The picker debounces, so the
// option only appears once the search has settled.
async function pickPerson(user, name) {
  await user.type(screen.getByRole('textbox', { name: /Share(d)? with/i }), name);
  const option = await screen.findByRole('button', { name: new RegExp(name, 'i') }, { timeout: 3000 });
  await user.click(option);
}

function postBody(authFetch) {
  const call = authFetch.mock.calls.find(([url, opts]) => url === '/api/matrix/shares' && opts?.method === 'POST');
  return call ? JSON.parse(call[1].body) : null;
}

describe('ShareMatrixDialog — sharing a matrix that is not saved yet', () => {
  function open({ managed = 'gaps', filter = FILTER, create } = {}) {
    const authFetch = stubApi({ create });
    const onClose = vi.fn();
    renderWithProviders(
      <ShareMatrixDialog filter={filter} managed={managed} onClose={onClose} />,
      { auth: { ...sharer, authFetch } },
    );
    return { authFetch, onClose, user: userEvent.setup() };
  }

  it('asks for ONE name and saves the matrix under it while sharing', async () => {
    const { authFetch, user } = open({ managed: 'gaps' });
    await user.type(screen.getByRole('textbox', { name: /Name this matrix/i }), 'Sales team access');
    await pickPerson(user, 'Ann Manager');
    await pickPerson(user, 'Bob Owner');
    await user.click(screen.getByRole('button', { name: 'Save & share' }));

    await waitFor(() => expect(postBody(authFetch)).not.toBeNull());
    expect(postBody(authFetch)).toEqual({
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

  it('refuses to share without a name, and without anybody to share with', async () => {
    const { authFetch, user } = open();
    const share = () => screen.getByRole('button', { name: 'Save & share' });

    await pickPerson(user, 'Ann Manager');
    expect(share()).toBeDisabled();                       // named nobody-thing

    await user.type(screen.getByRole('textbox', { name: /Name this matrix/i }), 'Sales team access');
    expect(share()).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /Remove Ann Manager/i }));
    expect(share()).toBeDisabled();                       // a link anyone opens is not offered
    expect(postBody(authFetch)).toBeNull();
  });

  it('records the rotated display mode when that is what the sharer was viewing', async () => {
    const { authFetch, user } = open({ filter: { ...FILTER, orientation: 'rows-as-subjects' } });
    await user.type(screen.getByRole('textbox', { name: /Name this matrix/i }), 'Rotated view');
    await pickPerson(user, 'Ann Manager');
    await user.click(screen.getByRole('button', { name: 'Save & share' }));

    await waitFor(() => expect(postBody(authFetch)?.displayMode).toBe('rotated'));
  });

  it('shows the link addressed by share id, names who it opens for, and copies it', async () => {
    const { user } = open();
    await user.type(screen.getByRole('textbox', { name: /Name this matrix/i }), 'Sales team access');
    await pickPerson(user, 'Ann Manager');
    await user.click(screen.getByRole('button', { name: 'Save & share' }));

    const expected = buildShareUrl(SHARE_ID);
    expect(await screen.findByText(expected)).toBeInTheDocument();
    // The address rides in the fragment, so it can never reach a server log.
    expect(expected).toContain(`#shared:${SHARE_ID}`);
    expect(expected.split('#')[0]).not.toContain(SHARE_ID);
    // The form is gone — the share exists now and can't be re-created here.
    expect(screen.queryByRole('textbox', { name: /Name this matrix/i })).not.toBeInTheDocument();
    const sharedWith = screen.getByRole('list', { name: /Shared with/i });
    expect(sharedWith).toHaveTextContent('Ann Manager');

    // userEvent installs a real clipboard stub, so read back what landed there
    // — and CopyButton only says "copied" when the write actually resolved.
    await user.click(screen.getByRole('button', { name: /Copy share link/i }));
    expect(await screen.findByRole('button', { name: /Share link copied/i })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(expected);
  });

  // The name-clash rule: never a silent overwrite, always a chance to rename.
  it('shows a taken name inline and keeps the form open to rename', async () => {
    const { user, onClose } = open({
      create: jsonResponse({ error: 'A saved matrix named "Sales team access" already exists. Pick a different name.' }, { ok: false, status: 409 }),
    });
    await user.type(screen.getByRole('textbox', { name: /Name this matrix/i }), 'Sales team access');
    await pickPerson(user, 'Ann Manager');
    await user.click(screen.getByRole('button', { name: 'Save & share' }));

    expect(await screen.findByText(/already exists. Pick a different name/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Name this matrix/i })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Done without creating anything', async () => {
    const { user, onClose, authFetch } = open();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
    expect(postBody(authFetch)).toBeNull();
  });
});

describe('ShareMatrixDialog — sharing a matrix that is already saved', () => {
  it('never asks for the name again, and shares the saved matrix by id', async () => {
    const authFetch = stubApi();
    renderWithProviders(
      <ShareMatrixDialog filter={FILTER} managed="all" savedFilterId={SAVED_ID} savedName="Sales team access" onClose={() => {}} />,
      { auth: { ...sharer, authFetch } },
    );
    const user = userEvent.setup();

    // The dialog is titled with the matrix's own name, and offers no name field.
    expect(await screen.findByText(/Sales team access/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Name this matrix/i })).not.toBeInTheDocument();

    await pickPerson(user, 'Ann Manager');
    await user.click(screen.getByRole('button', { name: 'Share matrix' }));

    await waitFor(() => expect(postBody(authFetch)).not.toBeNull());
    expect(postBody(authFetch)).toEqual({
      savedFilterId: SAVED_ID,
      recipients: [{ principalId: ANN.id, userKey: 'ann@contoso.com', displayName: 'Ann Manager' }],
    });
  });

  it('manages the existing share in place instead of minting a second one', async () => {
    const authFetch = stubApi({ shares: [LIVE_SHARE] });
    renderWithProviders(
      <ShareMatrixDialog filter={FILTER} managed="all" savedFilterId={SAVED_ID} savedName="Sales team access" onClose={() => {}} />,
      { auth: { ...sharer, authFetch } },
    );
    const user = userEvent.setup();

    expect(await screen.findByText(/Shared with 1 person/)).toBeInTheDocument();
    // The link is copyable again — that is what addressing by id bought.
    expect(screen.getByText(buildShareUrl(SHARE_ID))).toBeInTheDocument();

    // Replace Ann with Bob. There is no Save button any more: the list writes
    // itself back once it settles, which is what stops somebody being added and
    // silently never given access.
    expect(screen.queryByRole('button', { name: /Save recipients/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Remove Ann Manager/i }));
    await pickPerson(user, 'Bob Owner');

    await waitFor(
      () => expect(authFetch).toHaveBeenCalledWith(`/api/matrix/shares/${SHARE_ID}/recipients`, expect.anything()),
      { timeout: 3000 },
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    const [, opts] = authFetch.mock.calls.find(([url]) => String(url).endsWith('/recipients'));
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body).recipients).toEqual([
      { principalId: BOB.id, userKey: 'bob@contoso.com', displayName: 'Bob Owner' },
    ]);
    expect(postBody(authFetch)).toBeNull();
  });

  it('never writes back an empty list, and points at Stop sharing instead', async () => {
    const authFetch = stubApi({ shares: [LIVE_SHARE] });
    renderWithProviders(
      <ShareMatrixDialog filter={FILTER} managed="all" savedFilterId={SAVED_ID} savedName="Sales team access" onClose={() => {}} />,
      { auth: { ...sharer, authFetch } },
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Remove Ann Manager/i }));
    // The API refuses a share addressed to nobody, so autosaving one would only
    // produce an error the author cannot act on. Removing the last person is
    // "stop sharing", which is a deliberate, confirmed act.
    expect(await screen.findByText(/A share needs at least one person/)).toBeInTheDocument();
    await new Promise(r => setTimeout(r, 1200));
    expect(authFetch.mock.calls.some(([url]) => String(url).endsWith('/recipients'))).toBe(false);
  });

  it('stops sharing after a confirmation that says the saved matrix stays', async () => {
    const authFetch = stubApi({ shares: [LIVE_SHARE] });
    renderWithProviders(
      <ShareMatrixDialog filter={FILTER} managed="all" savedFilterId={SAVED_ID} savedName="Sales team access" onClose={() => {}} />,
      { auth: { ...sharer, authFetch } },
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Stop sharing' }));
    expect(await screen.findByText(/The saved matrix .* stays/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Stop sharing' }).at(-1));

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(`/api/matrix/shares/${SHARE_ID}/revoke`, expect.anything()));
  });
});

describe('WizardShareStep — the Share with section of the wizard’s last step', () => {
  // Picking people here must NOT share by itself: the wizard's one primary button
  // saves the matrix and then shares it. So the section is the people field and
  // nothing that POSTs.
  it('offers the same people field as the share form, and no button of its own', async () => {
    const authFetch = stubApi();
    const onRecipientsChange = vi.fn();
    renderWithProviders(
      <WizardShareStep filter={FILTER} managed="all" recipients={[]} onRecipientsChange={onRecipientsChange} />,
      { auth: { ...sharer, authFetch } },
    );
    const user = userEvent.setup();

    expect(screen.queryByRole('textbox', { name: /Name this matrix/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save & share|Share matrix/ })).not.toBeInTheDocument();
    await pickPerson(user, 'Ann Manager');
    expect(onRecipientsChange).toHaveBeenLastCalledWith([
      { principalId: ANN.id, userKey: 'ann@contoso.com', displayName: 'Ann Manager' },
    ]);
    expect(postBody(authFetch)).toBeNull();
  });

  // The #1202 repro: adjust a shared matrix and the wizard shows it is shared.
  it('shows the shared state of the matrix being adjusted, and manages it there', async () => {
    const authFetch = stubApi({ shares: [LIVE_SHARE] });
    renderWithProviders(
      <WizardShareStep filter={FILTER} managed="all" recipients={[]} onRecipientsChange={() => {}} saved={{ id: SAVED_ID, name: 'Sales team access', shared: true, recipientCount: 1 }} />,
      { auth: { ...sharer, authFetch } },
    );

    expect(await screen.findByText(/Shared with 1 person/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop sharing' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^Share with/i })).not.toBeInTheDocument();
  });

  it('offers new recipients, not the original’s, when the shared matrix is saved as a copy', () => {
    renderWithProviders(
      <WizardShareStep copy filter={FILTER} managed="all" recipients={[]} onRecipientsChange={() => {}} saved={{ id: SAVED_ID, name: 'Sales team access', shared: true }} />,
      { auth: { ...sharer, authFetch: stubApi({ shares: [LIVE_SHARE] }) } },
    );
    expect(screen.getByRole('textbox', { name: /^Share with/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop sharing' })).not.toBeInTheDocument();
  });

  it('offers nothing to share when the matrix is too large to load — but still manages an existing share', async () => {
    const { unmount } = renderWithProviders(<WizardShareStep filter={FILTER} managed="all" recipients={[]} blocked />, { auth: sharer });
    expect(screen.getByText(/too large to load/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^Share with/i })).not.toBeInTheDocument();
    unmount();

    renderWithProviders(
      <WizardShareStep blocked filter={FILTER} managed="all" recipients={[]} saved={{ id: SAVED_ID, name: 'Sales team access', shared: true }} />,
      { auth: { ...sharer, authFetch: stubApi({ shares: [LIVE_SHARE] }) } },
    );
    expect(await screen.findByRole('button', { name: 'Stop sharing' })).toBeInTheDocument();
    expect(screen.queryByText(/too large to load/i)).not.toBeInTheDocument();
  });
});
