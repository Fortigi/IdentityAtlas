// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ManualContextEditor from './ManualContextEditor';
import { addSubUnit } from './addSubUnit';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const attrs = {
  id: 'ctx-1', variant: 'manual', targetType: 'Resource', contextType: 'Application',
  displayName: 'Payroll', description: '', ownerUserId: 'legacy-owner', contextCategory: 'LogicalApplication',
  parentContextId: null, parentDisplayName: null,
};

function mount(overrides = {}, props = {}) {
  const authFetch = makeAuthFetch((url, opts = {}) => {
    if (String(url) === '/api/contexts/tree') return [];
    if (opts.method === 'DELETE') return jsonResponse(null, { status: 204 });
    if (opts.method === 'PATCH' || opts.method === 'POST') return { id: 'ctx-x', ...JSON.parse(opts.body) };
    return undefined;
  });
  const onUpdated = vi.fn();
  const onDeleted = vi.fn();
  renderWithProviders(h(ManualContextEditor, { contextId: 'ctx-1', attrs: { ...attrs, ...overrides }, onUpdated, onDeleted, ...props }), { auth: { authFetch } });
  return { authFetch, onUpdated, onDeleted, user: userEvent.setup() };
}

const sent = (authFetch, method) => JSON.parse(authFetch.mock.calls.find(([, o]) => o?.method === method)[1].body);

describe('ManualContextEditor — the template', () => {
  it('shows the loaded template and saves a changed one, sending the owner back untouched', async () => {
    const { authFetch, onUpdated, user } = mount();
    const template = screen.getByRole('combobox', { name: 'Template' });
    expect(template).toHaveValue('LogicalApplication');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await user.selectOptions(template, 'OrganizationalUnit');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(sent(authFetch, 'PATCH')).toMatchObject({ displayName: 'Payroll', contextCategory: 'OrganizationalUnit', ownerUserId: 'legacy-owner' });
  });

  it('offers "no template" for an unclassified context and sends null for it', async () => {
    const { authFetch, user } = mount({ contextCategory: null });
    const template = screen.getByRole('combobox', { name: 'Template' });
    expect(template).toHaveValue('');
    await user.selectOptions(template, 'Tag');
    await user.selectOptions(template, '');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sent(authFetch, 'PATCH')).toMatchObject({ displayName: 'Payroll!', contextCategory: null }));
  });
});

describe('ManualContextEditor — one form, plain words', () => {
  it('has no Owner field, no add-child form and one Delete', () => {
    mount();
    expect(screen.queryByText(/Owner/)).toBeNull();
    expect(screen.queryByRole('textbox', { name: /child/i })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Delete/ })).toHaveLength(1);
    expect(screen.getByTitle('Choose a parent')).toHaveTextContent('None (top level)');
    expect(screen.queryByTestId('edit-note')).toBeNull();
    expect(document.body.textContent).not.toMatch(/plugin|analyst|Principal-targeted/);
  });

  it('tells a derived unit which edits survive its refresh', () => {
    mount({ variant: 'generated', sourceAlgorithmName: 'department-from-principal' });
    expect(screen.getByTestId('edit-note')).toHaveTextContent(
      'This unit is derived from the department field on each account. A new name or parent you set here is kept when it refreshes.');
  });

  it('Delete says the consequence in the confirm, and a cancel deletes nothing', async () => {
    const { authFetch, onDeleted, user } = mount({ variant: 'generated', sourceAlgorithmName: 'manager-hierarchy', scopeSystemName: 'EntraID', sourceAlgorithmDisplayName: 'Manager Hierarchy' });
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    await screen.findByText('Delete Payroll?');
    const dialog = document.body;
    expect(dialog).toHaveTextContent('the next refresh creates it again unless that rule changes');
    expect(dialog).toHaveTextContent('who reports to whom in EntraID');
    expect(dialog.textContent).not.toMatch(/plugin|additionalStopwords/);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(authFetch).not.toHaveBeenCalledWith('/api/contexts/ctx-1', expect.objectContaining({ method: 'DELETE' }));

    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('a created unit\'s confirm does not talk about refreshing', async () => {
    const { user } = mount();
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    await screen.findByText('Delete Payroll?');
    const dialog = document.body;
    expect(dialog).toHaveTextContent('It cannot be undone.');
    expect(dialog.textContent).not.toMatch(/refresh/);
  });
});

describe('addSubUnit', () => {
  it('creates a manual child with the parent\'s kind, type and template', async () => {
    const authFetch = makeAuthFetch((url, opts = {}) => (opts.method === 'POST' ? { id: 'new', ...JSON.parse(opts.body) } : undefined));
    const created = await addSubUnit(authFetch, attrs, 'Payroll test');
    expect(created.id).toBe('new');
    expect(JSON.parse(authFetch.mock.calls[0][1].body)).toEqual({
      displayName: 'Payroll test', contextType: 'Application', contextCategory: 'LogicalApplication', targetType: 'Resource', parentContextId: 'ctx-1',
    });
  });

  it('starts as a Segment of type Manual when the parent has neither, and throws the API refusal', async () => {
    const ok = makeAuthFetch((url, opts = {}) => ({ id: 'n', ...JSON.parse(opts.body) }));
    const created = await addSubUnit(ok, { id: 'p', targetType: 'Identity' }, 'X');
    expect(created).toMatchObject({ contextType: 'Manual', contextCategory: 'Segment' });
    const refused = makeAuthFetch(() => jsonResponse({ error: 'no' }, { ok: false, status: 400 }));
    await expect(addSubUnit(refused, attrs, 'X')).rejects.toThrow('no');
  });
});
