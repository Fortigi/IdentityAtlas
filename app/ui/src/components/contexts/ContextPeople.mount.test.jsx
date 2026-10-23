// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ContextPeople from './ContextPeople';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

const ORG = { id: 'ctx-1', contextCategory: 'OrganizationalUnit' };

const ROLES = [
  { id: 'r-acc', role: 'Accountable', principalId: 'p-1', identityId: null, displayName: 'Mara Lindqvist', addedBy: 'algorithm' },
  { id: 'r-res', role: 'Responsible', principalId: 'p-2', identityId: null, displayName: 'Tom Okafor', addedBy: 'analyst' },
];

// Serves the roles (read from `state` so a write shows up on reload), the
// people search, and records every write. Writes can be made to fail.
function api({ roles = ROLES, failWrite = null } = {}) {
  const state = { roles: [...roles] };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    if (failWrite && (opts.method === 'PUT' || opts.method === 'DELETE')) {
      return jsonResponse({ error: failWrite }, { ok: false, status: 400 });
    }
    if (u.startsWith('/api/contexts/ctx-1/roles/') && opts.method === 'DELETE') {
      state.roles = state.roles.filter(r => r.id !== u.split('/').pop());
      return jsonResponse(null, { status: 204 });
    }
    if (u === '/api/contexts/ctx-1/roles' && opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      const row = { id: `r-${body.principalId}`, ...body, displayName: 'Ann Manager', addedBy: 'analyst' };
      state.roles = state.roles.filter(r => body.role !== 'Accountable' || r.role !== 'Accountable').concat(row);
      return row;
    }
    if (u === '/api/contexts/ctx-1/roles') return state.roles;
    if (u.startsWith('/api/users?search=ann')) return { data: [{ id: 'p-ann', displayName: 'Ann Manager', userPrincipalName: 'ann@contoso.com' }] };
    if (u.startsWith('/api/users?search=tom')) return { data: [{ id: 'p-2', displayName: 'Tom Okafor' }] };
    if (u.startsWith('/api/users?')) return { data: [] };
    return undefined;
  });
  return { authFetch, state };
}

function mount(attrs, { auth = {}, onOpenDetail } = {}) {
  const { authFetch, state } = auth.api || api();
  renderWithProviders(h(ContextPeople, { attrs, onOpenDetail }), { auth: { authFetch, ...auth.value } });
  return { authFetch, state, user: userEvent.setup() };
}

// The holders of a role, as text: the role block minus its label and helper.
const fact = (label) => {
  const block = screen.getByRole('group', { name: label });
  return block.lastElementChild;
};
const writes = (authFetch) => authFetch.mock.calls.filter(([, o]) => o?.method === 'PUT' || o?.method === 'DELETE');

async function pickPerson(user, term, name) {
  await user.type(screen.getByRole('textbox', { name: /Find a person|Add a person/ }), term);
  await user.click(await screen.findByRole('button', { name: new RegExp(name) }));
}

describe('ContextPeople (mounted)', () => {
  it('renders nothing for a Segment or a Tag — they carry no roles', () => {
    const { authFetch } = mount({ id: 'ctx-1', contextCategory: 'Segment' });
    expect(screen.queryByText('People')).toBeNull();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('renders nothing for a context without a template', () => {
    mount({ id: 'ctx-1', contextCategory: null });
    expect(screen.queryByText('People')).toBeNull();
  });

  it('shows each role as a people block: label, what it means, initials and name; no inline pickers', async () => {
    mount(ORG);
    expect(await screen.findByText('Mara Lindqvist')).toBeInTheDocument();
    expect(fact('Accountable')).toHaveTextContent(/^MLMara Lindqvist$/);
    expect(fact('Responsible')).toHaveTextContent(/^TOTom Okafor$/);
    expect(screen.getByRole('group', { name: 'Accountable' })).toHaveTextContent('Answers for who may access this unit');
    expect(screen.getByRole('group', { name: 'Responsible' })).toHaveTextContent('Keeps the membership and access correct day to day');
    // Who added a role is bookkeeping, not shown to the reader.
    expect(screen.queryByTitle(/Added by/)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    // One pencil per role.
    expect(screen.getByRole('button', { name: 'Edit Accountable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Responsible' })).toBeInTheDocument();
  });

  it('says nobody holds a role, with a Set button for an editor instead of a pencil', async () => {
    const { user } = mount(ORG, { auth: { api: api({ roles: [] }) } });
    await waitFor(() => expect(fact('Accountable')).toHaveTextContent(/^Nobody is accountable yet.Set accountable$/));
    expect(fact('Responsible')).toHaveTextContent(/^Nobody is responsible yet.Set responsible$/);
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Set responsible' }));
    expect(screen.getByRole('heading', { name: 'Edit Responsible' })).toBeInTheDocument();
    expect(screen.getByTestId('role-helper')).toHaveTextContent('Responsible: keeps the membership and access correct day to day.');
  });

  it('an application calls its Accountable the Owner, in the empty sentence too, and a reader gets no Set button', async () => {
    renderWithProviders(h(ContextPeople, { attrs: { id: 'ctx-1', contextCategory: 'LogicalApplication' }, accountableLabel: 'Owner', noun: 'this application' }),
      { auth: { authFetch: api({ roles: [] }).authFetch, hasWildcard: false, permissions: new Set(['data.read']) } });
    await waitFor(() => expect(fact('Owner')).toHaveTextContent(/^No owner yet.$/));
    expect(screen.getByRole('group', { name: 'Owner' })).toHaveTextContent('Answers for who may access this application');
    expect(screen.queryByRole('button', { name: /^Set / })).toBeNull();
  });

  it('shows the holder e-mail on hover when the API gives one', async () => {
    mount(ORG, { auth: { api: api({ roles: [{ ...ROLES[0], email: 'mara@contoso.com' }] }) } });
    expect(await screen.findByTitle('mara@contoso.com')).toHaveTextContent('Mara Lindqvist');
  });

  // A synced context's owner is stated by the ingest (addedBy 'sync'); the chip
  // names the system it came from, and only for that provenance.
  it('names the source system on a role the sync added, and on no other', async () => {
    const roles = [
      { id: 'r-sync', role: 'Accountable', principalId: 'p-9', identityId: null, displayName: 'Ivo Brandt', addedBy: 'sync' },
      { id: 'r-res', role: 'Responsible', principalId: 'p-2', identityId: null, displayName: 'Tom Okafor', addedBy: 'analyst' },
    ];
    mount({ id: 'ctx-1', contextCategory: 'LogicalApplication', scopeSystemName: 'IdentityIQ' }, { auth: { api: api({ roles }) } });
    expect((await screen.findByText('Ivo Brandt')).parentElement).toHaveTextContent(/Ivo Brandt\s*from IdentityIQ$/);
    expect(screen.getByText('Tom Okafor').parentElement).not.toHaveTextContent('from');
    expect(screen.getAllByText(/^from /)).toHaveLength(1);
  });

  it('shows no source hint when the context names no source system', async () => {
    const roles = [{ id: 'r-sync', role: 'Accountable', principalId: 'p-9', identityId: null, displayName: 'Ivo Brandt', addedBy: 'sync' }];
    mount({ id: 'ctx-1', contextCategory: 'LogicalApplication' }, { auth: { api: api({ roles }) } });
    expect((await screen.findByText('Ivo Brandt')).parentElement).not.toHaveTextContent('from');
    expect(screen.queryByText(/^from /)).toBeNull();
  });

  it('opens the account behind a name', async () => {
    const onOpenDetail = vi.fn();
    mount(ORG, { onOpenDetail });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Mara Lindqvist' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p-1', 'Mara Lindqvist');
  });

  it('opens an identity when the role points at a person rather than an account', async () => {
    const onOpenDetail = vi.fn();
    const roles = [{ id: 'r-id', role: 'Responsible', principalId: null, identityId: 'i-9', displayName: 'Ida Person', addedBy: 'sync' }];
    mount(ORG, { onOpenDetail, auth: { api: api({ roles }) } });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Ida Person' }));
    expect(onOpenDetail).toHaveBeenCalledWith('identity', 'i-9', 'Ida Person');
  });

  it('hides the pencils from a reader', async () => {
    mount(ORG, { auth: { value: { hasWildcard: false, permissions: new Set(['data.read']) } } });
    expect(await screen.findByText('Mara Lindqvist')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
  });

  it('shows a failed roles read', async () => {
    const authFetch = makeAuthFetch({ '/api/contexts/ctx-1/roles': jsonResponse({}, { ok: false, status: 500 }) });
    renderWithProviders(h(ContextPeople, { attrs: ORG }), { auth: { authFetch } });
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
  });
});

describe('ContextPeople — the Accountable modal', () => {
  it('replaces the Accountable with the person looked up, on Save', async () => {
    const { authFetch, user } = mount(ORG);
    await screen.findByText('Mara Lindqvist');
    await user.click(screen.getByRole('button', { name: 'Edit Accountable' }));
    expect(screen.getByRole('heading', { name: 'Set Accountable' })).toBeInTheDocument();
    expect(screen.getByTestId('role-helper')).toHaveTextContent('Accountable: answers for who may access this unit.');
    expect(screen.getByText(/^Current:/)).toHaveTextContent('Current: Mara Lindqvist');
    // Nothing chosen yet: Save does nothing.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await pickPerson(user, 'ann', 'Ann Manager');
    expect(screen.getByText(/^New Accountable:/)).toHaveTextContent('Ann Manager');
    expect(writes(authFetch)).toEqual([]); // picking is not saving
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1/roles', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ role: 'Accountable', principalId: 'p-ann' }),
    }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Set Accountable' })).toBeNull());
    await waitFor(() => expect(fact('Accountable')).toHaveTextContent('Ann Manager'));
    expect(screen.queryByText('Mara Lindqvist')).toBeNull();
  });

  it('Clear removes the Accountable and closes', async () => {
    const { authFetch, user } = mount(ORG);
    await screen.findByText('Mara Lindqvist');
    await user.click(screen.getByRole('button', { name: 'Edit Accountable' }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1/roles/r-acc', expect.objectContaining({ method: 'DELETE' }));
    await waitFor(() => expect(fact('Accountable')).toHaveTextContent(/^Nobody is accountable yet/));
    expect(screen.queryByRole('heading', { name: 'Set Accountable' })).toBeNull();
    expect(fact('Responsible')).toHaveTextContent('Tom Okafor');
  });

  it('offers no Clear when nobody is Accountable', async () => {
    const { user } = mount(ORG, { auth: { api: api({ roles: [ROLES[1]] }) } });
    await screen.findByText('Tom Okafor');
    await user.click(screen.getByRole('button', { name: 'Set accountable' }));
    expect(screen.getByText(/^Current:/)).toHaveTextContent('Current: not set');
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('Cancel closes without writing, even after a pick', async () => {
    const { authFetch, user } = mount(ORG);
    await screen.findByText('Mara Lindqvist');
    await user.click(screen.getByRole('button', { name: 'Edit Accountable' }));
    await pickPerson(user, 'ann', 'Ann Manager');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Set Accountable' })).toBeNull();
    expect(writes(authFetch)).toEqual([]);
    expect(fact('Accountable')).toHaveTextContent('Mara Lindqvist');
  });

  it('keeps the modal open and shows the API refusal when the save fails', async () => {
    const { user } = mount(ORG, { auth: { api: api({ failWrite: 'roles are not allowed on this context' }) } });
    await screen.findByText('Mara Lindqvist');
    await user.click(screen.getByRole('button', { name: 'Edit Accountable' }));
    await pickPerson(user, 'ann', 'Ann Manager');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('roles are not allowed on this context')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Set Accountable' })).toBeInTheDocument();
    expect(fact('Accountable')).toHaveTextContent('Mara Lindqvist');
  });
});

describe('ContextPeople — the Responsible modal', () => {
  it('removes a holder straight away', async () => {
    const { authFetch, user } = mount(ORG);
    await screen.findByText('Tom Okafor');
    await user.click(screen.getByRole('button', { name: 'Edit Responsible' }));
    expect(screen.getByRole('heading', { name: 'Edit Responsible' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Tom Okafor as Responsible' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1/roles/r-res', expect.objectContaining({ method: 'DELETE' }));
    expect(await screen.findAllByText('Nobody is responsible yet.')).toHaveLength(2); // the modal and the page behind it
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(fact('Responsible')).toHaveTextContent(/^Nobody is responsible yet/);
    expect(fact('Accountable')).toHaveTextContent('Mara Lindqvist');
  });

  it('adds the person looked up, and lists them', async () => {
    const { authFetch, user } = mount(ORG);
    await screen.findByText('Tom Okafor');
    await user.click(screen.getByRole('button', { name: 'Edit Responsible' }));
    await pickPerson(user, 'ann', 'Ann Manager');
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1/roles', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ role: 'Responsible', principalId: 'p-ann' }),
    }));
    const list = await screen.findByRole('list', { name: 'Responsible' });
    await waitFor(() => expect(within(list).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Tom Okafor✕', 'Ann Manager✕']));
    expect(screen.getByRole('textbox', { name: 'Add a person' })).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(fact('Responsible')).toHaveTextContent(/^TOTom OkaforAMAnn Manager/);
  });

  it('does not add someone who is already Responsible', async () => {
    const { authFetch, user } = mount(ORG);
    await screen.findByText('Tom Okafor');
    await user.click(screen.getByRole('button', { name: 'Edit Responsible' }));
    await user.type(screen.getByRole('textbox', { name: 'Add a person' }), 'tom');
    const list = screen.getByRole('list', { name: 'Responsible' });
    const hit = (await screen.findAllByRole('button', { name: 'Tom Okafor' })).find(b => !list.contains(b));
    await user.click(hit);
    expect(writes(authFetch)).toEqual([]);
  });
});
