// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import BusinessRoleOwners from './BusinessRoleOwners';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

const BASE = '/api/access-package/br-1/owners';
const GUESS = { role: 'Accountable', principalId: 'p-mgr', displayName: 'Mara Lindqvist', reason: 'manages 8 of the 10 holders' };

function api({ owners = [], suggestions = { Accountable: GUESS, Responsible: null }, failPut = false } = {}) {
  const state = { owners: [...owners], suggestions, puts: [], deletes: [], rejects: [], suggestionCalls: 0 };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    if (u === `${BASE}/suggestions/reject`) {
      state.rejects.push(JSON.parse(opts.body));
      state.suggestions = { Accountable: null, Responsible: null };
      return jsonResponse(null, { status: 204 });
    }
    if (u === `${BASE}/suggestions`) { state.suggestionCalls++; return state.suggestions; }
    if (u === BASE && opts.method === 'PUT') {
      if (failPut) return jsonResponse({ error: 'not allowed' }, { ok: false, status: 403 });
      const body = JSON.parse(opts.body);
      state.puts.push(body);
      state.owners.push({ id: 'o-new', ...body, displayName: 'Mara Lindqvist', addedBy: 'analyst' });
      state.suggestions = { Accountable: null, Responsible: null };
      return state.owners.at(-1);
    }
    if (u.startsWith(`${BASE}/`) && opts.method === 'DELETE') {
      state.deletes.push(u.slice(BASE.length + 1));
      state.owners = state.owners.filter(o => o.id !== u.slice(BASE.length + 1));
      return jsonResponse(null, { status: 204 });
    }
    if (u === BASE) return state.owners;
    if (u.startsWith('/api/users?')) return { data: [] };
    return undefined;
  });
  return { authFetch, state };
}

const WRITER = { hasWildcard: false, permissions: new Set(['data.write.contexts']) };

function mount({ auth = WRITER, shared = false, ...opts } = {}) {
  const { authFetch, state } = api(opts);
  const el = h(BusinessRoleOwners, { roleId: 'br-1' });
  renderWithProviders(shared ? h(SharedViewContext.Provider, { value: true }, el) : el, { auth: { authFetch, ...auth } });
  return { state, user: userEvent.setup() };
}

const block = (name) => screen.getByRole('group', { name });

describe('BusinessRoleOwners', () => {
  it('shows who holds each role', async () => {
    mount({ owners: [
      { id: 'o1', role: 'Accountable', principalId: 'p1', displayName: 'Ann Accountable', addedBy: 'analyst' },
      { id: 'o2', role: 'Responsible', principalId: 'p2', displayName: 'Rob Responsible', addedBy: 'sync' },
    ] });
    expect(await within(block('Accountable')).findByText('Ann Accountable')).toBeInTheDocument();
    expect(within(block('Responsible')).getByText('Rob Responsible')).toBeInTheDocument();
    expect(screen.queryByTestId('owner-guess-Accountable')).toBeNull();
  });

  it('shows the suggestion and its reason under the empty place only', async () => {
    mount();
    const guess = await screen.findByTestId('owner-guess-Accountable');
    expect(guess).toHaveTextContent('Mara Lindqvist');
    expect(guess).toHaveTextContent('manages 8 of the 10 holders');
    expect(screen.queryByTestId('owner-guess-Responsible')).toBeNull();
  });

  it('Confirm sets the suggested person in that role', async () => {
    const { state, user } = mount();
    const guess = await screen.findByTestId('owner-guess-Accountable');
    await user.click(within(guess).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(state.puts).toEqual([{ role: 'Accountable', principalId: 'p-mgr' }]));
    expect(await within(block('Accountable')).findByText('Mara Lindqvist')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('owner-guess-Accountable')).toBeNull());
  });

  it('Not this person records the rejection for that role and drops the guess', async () => {
    const { state, user } = mount();
    const guess = await screen.findByTestId('owner-guess-Accountable');
    await user.click(within(guess).getByRole('button', { name: 'Not this person' }));
    await waitFor(() => expect(state.rejects).toEqual([{ role: 'Accountable', principalId: 'p-mgr' }]));
    await waitFor(() => expect(screen.queryByTestId('owner-guess-Accountable')).toBeNull());
    expect(state.puts).toEqual([]);
  });

  it('Choose someone else opens the pop-up for that role', async () => {
    const { user } = mount();
    const guess = await screen.findByTestId('owner-guess-Accountable');
    await user.click(within(guess).getByRole('button', { name: 'Choose someone else' }));
    expect(await screen.findByText('Set Accountable')).toBeInTheDocument();
  });

  it('shows the API error when a write is refused', async () => {
    const { user } = mount({ failPut: true });
    const guess = await screen.findByTestId('owner-guess-Accountable');
    await user.click(within(guess).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not allowed');
  });

  it('removes a Responsible through the pop-up', async () => {
    const { state, user } = mount({
      suggestions: {},
      owners: [{ id: 'o2', role: 'Responsible', principalId: 'p2', displayName: 'Rob Responsible', addedBy: 'sync' }],
    });
    await within(block('Responsible')).findByText('Rob Responsible');
    await user.click(screen.getByRole('button', { name: 'Edit Responsible' }));
    await user.click(await screen.findByRole('button', { name: 'Remove Rob Responsible as Responsible' }));
    await waitFor(() => expect(state.deletes).toEqual(['o2']));
  });

  it('gives a reader the suggestion without actions', async () => {
    mount({ auth: { hasWildcard: false, permissions: new Set(['data.read.matrix']) } });
    const guess = await screen.findByTestId('owner-guess-Accountable');
    expect(within(guess).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set accountable' })).toBeNull();
  });

  it('asks for no suggestion in a read-only view', async () => {
    const { state } = mount({ shared: true, owners: [{ id: 'o1', role: 'Accountable', principalId: 'p1', displayName: 'Ann Accountable', addedBy: 'analyst' }] });
    await within(block('Accountable')).findByText('Ann Accountable');
    expect(state.suggestionCalls).toBe(0);
    expect(screen.queryByRole('button', { name: 'Edit Accountable' })).toBeNull();
  });
});
