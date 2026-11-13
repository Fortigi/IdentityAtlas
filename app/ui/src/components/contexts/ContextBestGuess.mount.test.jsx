// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import ContextPeople from './ContextPeople';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

// The best guess lives inside ContextPeople's Accountable fact, so it is
// mounted through it — the way every profile uses it.
const ORG = { id: 'ctx-1', contextCategory: 'OrganizationalUnit' };
const GUESS = { role: 'Accountable', principalId: 'p-mgr', displayName: 'Mara Lindqvist', reason: 'manages 11 of the 14 members', count: 11, total: 14 };

// Serves roles from `state` (so a confirmed role shows up on reload), the
// suggestion (or a 204), and the reject; records the calls.
function api({ suggestion = GUESS, roles = [], failReject = false } = {}) {
  const state = { roles: [...roles], rejected: [] };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    if (u === '/api/contexts/ctx-1/roles/suggestion/reject') {
      if (failReject) return jsonResponse({ error: 'not allowed' }, { ok: false, status: 403 });
      state.rejected.push(JSON.parse(opts.body));
      return jsonResponse(null, { status: 204 });
    }
    if (u === '/api/contexts/ctx-1/roles/suggestion') {
      return suggestion ? suggestion : jsonResponse(undefined, { status: 204 });
    }
    if (u === '/api/contexts/ctx-1/roles' && opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      state.roles.push({ id: 'r-new', ...body, displayName: 'Mara Lindqvist', addedBy: 'analyst' });
      return state.roles.at(-1);
    }
    if (u === '/api/contexts/ctx-1/roles') return state.roles;
    if (u.startsWith('/api/users?search=ann')) return { data: [{ id: 'p-ann', displayName: 'Ann Manager' }] };
    if (u.startsWith('/api/users?')) return { data: [] };
    return undefined;
  });
  return { authFetch, state };
}

const accountableFact = () => screen.getByRole('group', { name: 'Accountable' }).lastElementChild;

function mount({ attrs = ORG, auth = {}, suggest = true, ...opts } = {}) {
  const { authFetch, state } = api(opts);
  renderWithProviders(h(ContextPeople, { attrs, suggest }), { auth: { authFetch, ...auth } });
  return { authFetch, state, user: userEvent.setup() };
}

describe('ContextPeople — the suggested Accountable', () => {
  it('shows the suggestion with its reason under the Accountable role', async () => {
    mount();
    const guess = await screen.findByTestId('best-guess');
    expect(guess).toHaveTextContent(/^Suggested: Mara Lindqvist· manages 11 of the 14 membersConfirmNot this personChoose someone else$/);
    expect(guess.textContent).not.toMatch(/Best guess|Reject/);
    expect(accountableFact()).toContainElement(guess);
    expect(accountableFact()).toHaveTextContent(/^Nobody is accountable yet/);
  });

  it('Confirm sets the Accountable and refreshes, after which the guess is gone', async () => {
    const { authFetch, user } = mount();
    await user.click(within(await screen.findByTestId('best-guess')).getByRole('button', { name: 'Confirm' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1/roles', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ role: 'Accountable', principalId: 'p-mgr' }),
    }));
    await waitFor(() => expect(screen.queryByTestId('best-guess')).toBeNull());
    expect(accountableFact()).toHaveTextContent(/^MLMara Lindqvist$/);
  });

  it('Not this person tells the API who was rejected and hides the guess', async () => {
    const { state, user } = mount();
    await user.click(within(await screen.findByTestId('best-guess')).getByRole('button', { name: 'Not this person' }));
    await waitFor(() => expect(screen.queryByTestId('best-guess')).toBeNull());
    expect(state.rejected).toEqual([{ principalId: 'p-mgr' }]);
    expect(accountableFact()).toHaveTextContent(/^Nobody is accountable yet/);
  });

  it('a person-level guess is confirmed and rejected by identity', async () => {
    const { authFetch, state, user } = mount({ suggestion: { ...GUESS, principalId: undefined, identityId: 'i-7' } });
    await user.click(within(await screen.findByTestId('best-guess')).getByRole('button', { name: 'Not this person' }));
    await waitFor(() => expect(state.rejected).toEqual([{ identityId: 'i-7' }]));
    expect(authFetch).not.toHaveBeenCalledWith('/api/contexts/ctx-1/roles', expect.objectContaining({ method: 'PUT' }));
  });

  it('keeps the guess and shows why when the reject is refused', async () => {
    const { user } = mount({ failReject: true });
    await user.click(within(await screen.findByTestId('best-guess')).getByRole('button', { name: 'Not this person' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not allowed');
    expect(screen.getByTestId('best-guess')).toBeInTheDocument();
  });

  it('Choose someone else opens the Accountable modal with the lookup focused', async () => {
    const { authFetch, user } = mount();
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(within(await screen.findByTestId('best-guess')).getByRole('button', { name: 'Choose someone else' }));
    expect(screen.getByRole('heading', { name: 'Set Accountable' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Find a person' })).toHaveFocus();

    await user.keyboard('ann');
    await user.click(await screen.findByRole('button', { name: /Ann Manager/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1/roles', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ role: 'Accountable', principalId: 'p-ann' }),
    }));
  });

  it('shows a reader the suggestion without Confirm, Not this person, Choose someone else or a pencil', async () => {
    mount({ auth: { hasWildcard: false, permissions: new Set(['data.read']) } });
    expect(await screen.findByTestId('best-guess')).toHaveTextContent('Mara Lindqvist');
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Not this person' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose someone else' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Accountable' })).toBeNull();
  });

  it('shows nothing when the API has no suggestion (204)', async () => {
    const { authFetch } = mount({ suggestion: null });
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1/roles/suggestion'));
    await waitFor(() => expect(accountableFact()).toHaveTextContent(/^Nobody is accountable yet.Set accountable$/));
    expect(screen.queryByTestId('best-guess')).toBeNull();
  });

  it('does not ask for a guess while an Accountable is set, or when the caller did not ask', async () => {
    const roles = [{ id: 'r1', role: 'Accountable', principalId: 'p-1', displayName: 'Tom Okafor', addedBy: 'analyst' }];
    const first = mount({ roles });
    expect(await screen.findByText('Tom Okafor')).toBeInTheDocument();
    expect(first.authFetch).not.toHaveBeenCalledWith('/api/contexts/ctx-1/roles/suggestion');
  });

  it('does not ask for a guess without the suggest flag (the generic header use)', async () => {
    const { authFetch } = mount({ suggest: false });
    await waitFor(() => expect(accountableFact()).toHaveTextContent(/^Nobody is accountable yet.Set accountable$/));
    expect(authFetch).not.toHaveBeenCalledWith('/api/contexts/ctx-1/roles/suggestion');
  });
});
