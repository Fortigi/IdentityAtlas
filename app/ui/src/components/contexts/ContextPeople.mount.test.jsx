// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ContextPeople from './ContextPeople';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

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
    if (u.startsWith('/api/users?')) return { data: [] };
    return undefined;
  });
  return { authFetch, state };
}

function mount(attrs, { auth = {}, onOpenDetail } = {}) {
  const { authFetch, state } = auth.api || api();
  renderWithProviders(h(ContextPeople, { attrs, onOpenDetail }), { auth: { authFetch, ...auth.value } });
  return { authFetch, state };
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

  it('lists the accountable and the responsible, with who added each', async () => {
    mount(ORG);
    expect(await screen.findByText('Mara Lindqvist')).toBeInTheDocument();
    expect(screen.getByText('Tom Okafor')).toBeInTheDocument();
    expect(screen.getByTitle('Added by algorithm')).toHaveTextContent('Mara Lindqvist');
    expect(screen.getByTitle('Added by analyst')).toHaveTextContent('Tom Okafor');
    expect(screen.queryByText('not set')).toBeNull();
  });

  it('says "not set" / "none" when nobody holds a role, and the application template counts too', async () => {
    mount({ id: 'ctx-1', contextCategory: 'LogicalApplication' }, { auth: { api: api({ roles: [] }) } });
    expect(await screen.findByText('not set')).toBeInTheDocument();
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  // A synced context's owner is stated by the ingest (addedBy 'sync'); the chip
  // names the system it came from, and only for that provenance.
  it('names the source system on a role the sync added, and on no other', async () => {
    const roles = [
      { id: 'r-sync', role: 'Accountable', principalId: 'p-9', identityId: null, displayName: 'Ivo Brandt', addedBy: 'sync' },
      { id: 'r-res', role: 'Responsible', principalId: 'p-2', identityId: null, displayName: 'Tom Okafor', addedBy: 'analyst' },
    ];
    mount({ id: 'ctx-1', contextCategory: 'LogicalApplication', scopeSystemName: 'IdentityIQ' }, { auth: { api: api({ roles }) } });
    expect(await screen.findByTitle('Added by sync')).toHaveTextContent(/^Ivo Brandt\s*from IdentityIQ/);
    expect(screen.getByTitle('Added by analyst')).not.toHaveTextContent('from');
    expect(screen.getAllByText(/^from /)).toHaveLength(1);
  });

  it('shows no source hint when the context names no source system', async () => {
    const roles = [{ id: 'r-sync', role: 'Accountable', principalId: 'p-9', identityId: null, displayName: 'Ivo Brandt', addedBy: 'sync' }];
    mount({ id: 'ctx-1', contextCategory: 'LogicalApplication' }, { auth: { api: api({ roles }) } });
    expect(await screen.findByTitle('Added by sync')).not.toHaveTextContent('from');
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

  it('removes a role and shows the list without it', async () => {
    const { authFetch } = mount(ORG);
    const user = userEvent.setup();
    await screen.findByText('Tom Okafor');
    await user.click(screen.getByRole('button', { name: 'Remove Tom Okafor as Responsible' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1/roles/r-res', expect.objectContaining({ method: 'DELETE' }));
    await waitFor(() => expect(screen.queryByText('Tom Okafor')).toBeNull());
    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getByText('Mara Lindqvist')).toBeInTheDocument();
  });

  it('searches people and adds the chosen one with the chosen role', async () => {
    const { authFetch } = mount(ORG);
    const user = userEvent.setup();
    await screen.findByText('Tom Okafor');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Role to add' }), 'Accountable');
    await user.type(screen.getByRole('textbox', { name: 'Add a person' }), 'ann');
    await user.click(await screen.findByRole('button', { name: /Ann Manager/ }));

    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1/roles', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ role: 'Accountable', principalId: 'p-ann' }),
    }));
    // The new accountable replaces the old one; the search box is cleared.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Ann Manager as Accountable' })).toBeInTheDocument());
    expect(screen.queryByText('Mara Lindqvist')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Add a person' })).toHaveValue('');
  });

  it('hides the add and remove controls from a reader', async () => {
    mount(ORG, { auth: { value: { hasWildcard: false, permissions: new Set(['data.read']) } } });
    expect(await screen.findByText('Mara Lindqvist')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Add a person' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
  });

  it('shows the API refusal when a write fails', async () => {
    mount(ORG, { auth: { api: api({ failWrite: 'roles are not allowed on this context' }) } });
    const user = userEvent.setup();
    await screen.findByText('Tom Okafor');
    await user.click(screen.getByRole('button', { name: 'Remove Tom Okafor as Responsible' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('roles are not allowed on this context');
    // Nothing was removed.
    expect(screen.getByText('Tom Okafor')).toBeInTheDocument();
  });

  it('shows a failed roles read', async () => {
    const authFetch = makeAuthFetch({ '/api/contexts/ctx-1/roles': jsonResponse({}, { ok: false, status: 500 }) });
    renderWithProviders(h(ContextPeople, { attrs: ORG }), { auth: { authFetch } });
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
  });
});
