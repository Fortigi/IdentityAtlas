// @vitest-environment jsdom
//
// Mount tests for the people multi-select (#1166).
//
// Inputs are chosen to discriminate: the directory rows include a person who
// has NO sign-in name, and a search whose term differs from the display name,
// so an implementation that selected everything returned — or that keyed the
// selection on the display name instead of the sign-in name — fails here.

import { describe, it, expect, vi } from 'vitest';
import PeoplePicker, { toPerson } from './PeoplePicker';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const ANN = { id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', displayName: 'Ann Manager', userPrincipalName: 'ann@contoso.com' };
const BOB = { id: '5c9e2a11-1111-2222-3333-444455556666', displayName: 'Bob Owner', userPrincipalName: 'bob@contoso.com' };
// A service principal / mail-less account: visible, but cannot be a recipient.
const SVC = { id: '99999999-9999-9999-9999-999999999999', displayName: 'Backup Service', userPrincipalName: null };

function mount({ value = [], rows = [ANN, BOB, SVC], response } = {}) {
  const authFetch = makeAuthFetch({ '/api/users': response ?? { data: rows } });
  const onChange = vi.fn();
  renderWithProviders(<PeoplePicker value={value} onChange={onChange} />, {
    auth: { permissions: new Set(['data.share']), hasWildcard: false, permissionsLoaded: true, authFetch },
  });
  return { authFetch, onChange, user: userEvent.setup() };
}

const searchBox = () => screen.getByRole('textbox', { name: /Search people/i });
// Scoped to the dropdown: an already-selected person also appears as a chip
// whose Remove button carries their name, so an unscoped query is ambiguous.
const option = async (name) =>
  within(await screen.findByRole('group', { name: 'Search results' })).getByRole('button', { name: new RegExp(name, 'i') });

describe('toPerson', () => {
  it('keys a person on their sign-in name and keeps the directory id', () => {
    expect(toPerson(ANN)).toEqual({
      principalId: ANN.id, userKey: 'ann@contoso.com', displayName: 'Ann Manager',
    });
  });

  it('falls back to the mail column when the row has no userPrincipalName', () => {
    expect(toPerson({ id: 'x', displayName: 'Mailed', email: 'mail@contoso.com' }).userKey).toBe('mail@contoso.com');
  });

  it('yields an empty key for a row that cannot sign in', () => {
    expect(toPerson(SVC).userKey).toBe('');
  });
});

describe('PeoplePicker', () => {
  it('searches the directory for what was typed, debounced', async () => {
    const { authFetch, user } = mount();
    await user.type(searchBox(), 'ann');
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    // One request for the settled term, not one per keystroke.
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch.mock.calls[0][0]).toBe('/api/users?search=ann&limit=10');
  });

  it('adds the person that was clicked, not the first result', async () => {
    const { onChange, user } = mount();
    await user.type(searchBox(), 'o');
    await user.click(await option('Bob Owner'));
    expect(onChange).toHaveBeenCalledWith([toPerson(BOB)]);
  });

  it('refuses a person with no sign-in name, saying why', async () => {
    const { onChange, user } = mount();
    await user.type(searchBox(), 'service');
    const row = await option('Backup Service');
    expect(row).toBeDisabled();
    expect(row).toHaveTextContent('cannot sign in');
    await user.click(row);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('will not add the same person twice', async () => {
    const { onChange, user } = mount({ value: [toPerson(ANN)] });
    await user.type(searchBox(), 'ann');
    const row = await option('Ann Manager');
    expect(row).toBeDisabled();
    expect(row).toHaveTextContent('already added');
    await user.click(row);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lists the selection as removable chips', async () => {
    const { onChange, user } = mount({ value: [toPerson(ANN), toPerson(BOB)] });
    const chips = screen.getByRole('list', { name: /Selected people/i });
    expect(chips).toHaveTextContent('Ann Manager');
    expect(chips).toHaveTextContent('Bob Owner');

    await user.click(screen.getByRole('button', { name: 'Remove Ann Manager' }));
    // Removal is by sign-in key: Bob survives, Ann goes.
    expect(onChange).toHaveBeenCalledWith([toPerson(BOB)]);
  });

  it('says so when nothing matches, rather than showing an empty box', async () => {
    const { user } = mount({ rows: [] });
    await user.type(searchBox(), 'nobody');
    expect(await screen.findByText(/No people match “nobody”/)).toBeInTheDocument();
  });

  it('survives a failing search without breaking the form', async () => {
    const { user } = mount({ response: jsonResponse({ error: 'nope' }, { ok: false, status: 500 }) });
    await user.type(searchBox(), 'ann');
    expect(await screen.findByText(/No people match/)).toBeInTheDocument();
    expect(searchBox()).toBeInTheDocument();
  });

  it('does not search on an empty term', async () => {
    const { authFetch, user } = mount();
    await user.click(searchBox());
    await user.type(searchBox(), '  ');
    await new Promise(r => setTimeout(r, 400));
    expect(authFetch).not.toHaveBeenCalled();
  });
});
