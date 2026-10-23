// @vitest-environment jsdom
//
// Admin → Authentication: the context-owner access checkbox.

import { describe, it, expect } from 'vitest';
import ContextOwnerAccessSection from './ContextOwnerAccessSection';
import AuthSettingsPage from '@ui/components/AuthSettingsPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const LABEL = /Context owners — people who are Accountable or Responsible/;

// A stand-in for the API that remembers what was saved, so the checkbox has to
// re-read the server's answer rather than trust its own click.
function server({ enabled = false, failPut = false } = {}) {
  const state = { enabled };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    if (!String(url).includes('/api/admin/context-owner-access')) return undefined;
    if (opts.method === 'PUT') {
      if (failPut) return jsonResponse({ error: 'Insufficient permissions' }, { ok: false, status: 403 });
      state.enabled = JSON.parse(opts.body).enabled;
    }
    return { enabled: state.enabled };
  });
  return { authFetch, state };
}

const puts = (authFetch) => authFetch.mock.calls.filter(([, o]) => o?.method === 'PUT');

describe('ContextOwnerAccessSection', () => {
  it('shows the stored state: off', async () => {
    renderWithProviders(<ContextOwnerAccessSection />, { auth: { authFetch: server().authFetch } });
    const box = await screen.findByRole('checkbox', { name: LABEL });
    await waitFor(() => expect(box).not.toBeDisabled());
    expect(box).not.toBeChecked();
  });

  it('shows the stored state: on', async () => {
    renderWithProviders(<ContextOwnerAccessSection />, { auth: { authFetch: server({ enabled: true }).authFetch } });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: LABEL })).toBeChecked());
  });

  it('turns it on with a PUT { enabled: true } and shows what the server then says', async () => {
    const { authFetch, state } = server();
    renderWithProviders(<ContextOwnerAccessSection />, { auth: { authFetch } });
    const box = await screen.findByRole('checkbox', { name: LABEL });
    await waitFor(() => expect(box).not.toBeDisabled());

    await userEvent.click(box);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: LABEL })).toBeChecked());
    expect(puts(authFetch)).toHaveLength(1);
    expect(JSON.parse(puts(authFetch)[0][1].body)).toEqual({ enabled: true });
    expect(state.enabled).toBe(true);
  });

  it('turns it off with { enabled: false }', async () => {
    const { authFetch } = server({ enabled: true });
    renderWithProviders(<ContextOwnerAccessSection />, { auth: { authFetch } });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: LABEL })).toBeChecked());
    await userEvent.click(screen.getByRole('checkbox', { name: LABEL }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: LABEL })).not.toBeChecked());
    expect(JSON.parse(puts(authFetch)[0][1].body)).toEqual({ enabled: false });
  });

  it('shows the API\'s error and stays off when the save is refused', async () => {
    const { authFetch } = server({ failPut: true });
    renderWithProviders(<ContextOwnerAccessSection />, { auth: { authFetch } });
    const box = await screen.findByRole('checkbox', { name: LABEL });
    await waitFor(() => expect(box).not.toBeDisabled());
    await userEvent.click(box);
    expect(await screen.findByRole('alert')).toHaveTextContent('Insufficient permissions');
    expect(screen.getByRole('checkbox', { name: LABEL })).not.toBeChecked();
  });

  it('sits on the Authentication admin page', async () => {
    const { authFetch } = server({ enabled: true });
    const all = makeAuthFetch((url, opts) => (String(url).includes('/api/admin/auth-settings')
      ? { enabled: true, tenantId: 't', clientId: 'c', requiredRoles: [] }
      : authFetch(url, opts)));
    renderWithProviders(<AuthSettingsPage />, { auth: { authFetch: all } });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: LABEL })).toBeChecked());
  });
});
