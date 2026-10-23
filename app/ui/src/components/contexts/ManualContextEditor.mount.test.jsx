// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ManualContextEditor from './ManualContextEditor';
import { renderWithProviders, makeAuthFetch, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const attrs = {
  id: 'ctx-1', variant: 'manual', targetType: 'Resource', contextType: 'Application',
  displayName: 'Payroll', description: '', ownerUserId: '', contextCategory: 'LogicalApplication',
  parentContextId: null, parentDisplayName: null,
};

function mount(overrides = {}, props = {}) {
  const authFetch = makeAuthFetch((url, opts = {}) => {
    if (String(url) === '/api/contexts/tree') return [];
    if (opts.method === 'PATCH' || opts.method === 'POST') return { id: 'ctx-x', ...JSON.parse(opts.body) };
    return undefined;
  });
  const onUpdated = vi.fn();
  renderWithProviders(h(ManualContextEditor, { contextId: 'ctx-1', attrs: { ...attrs, ...overrides }, onUpdated, ...props }), { auth: { authFetch } });
  return { authFetch, onUpdated, user: userEvent.setup() };
}

const sent = (authFetch, method) => JSON.parse(authFetch.mock.calls.find(([, o]) => o?.method === method)[1].body);

describe('ManualContextEditor — the template', () => {
  it('shows the loaded template and saves a changed one', async () => {
    const { authFetch, onUpdated, user } = mount();
    const template = screen.getByRole('combobox', { name: 'Template' });
    expect(template).toHaveValue('LogicalApplication');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await user.selectOptions(template, 'OrganizationalUnit');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(sent(authFetch, 'PATCH')).toMatchObject({ displayName: 'Payroll', contextCategory: 'OrganizationalUnit' });
  });

  it('offers "no template" for an unclassified context and sends null for it', async () => {
    const { authFetch, user } = mount({ contextCategory: null });
    const template = screen.getByRole('combobox', { name: 'Template' });
    expect(template).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await user.selectOptions(template, 'Tag');
    await user.selectOptions(template, '');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Display name' }), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sent(authFetch, 'PATCH')).toMatchObject({ displayName: 'Payroll!', contextCategory: null }));
  });

  it('starts a new child on the parent template and sends the chosen one', async () => {
    const { authFetch, onUpdated, user } = mount();
    const childTemplate = screen.getByRole('combobox', { name: 'Child template' });
    expect(childTemplate).toHaveValue('LogicalApplication');

    await user.selectOptions(childTemplate, 'Segment');
    await user.type(screen.getByRole('textbox', { name: 'Add child context' }), 'Payroll test{Enter}');

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(sent(authFetch, 'POST')).toMatchObject({
      displayName: 'Payroll test', contextCategory: 'Segment', contextType: 'Application', targetType: 'Resource', parentContextId: 'ctx-1',
    });
  });

  it('starts a new child as a Segment when the parent has no template', () => {
    mount({ contextCategory: null });
    expect(screen.getByRole('combobox', { name: 'Child template' })).toHaveValue('Segment');
  });
});
