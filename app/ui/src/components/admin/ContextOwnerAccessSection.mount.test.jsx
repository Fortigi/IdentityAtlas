// @vitest-environment jsdom
//
// Admin → Roles & Permissions → Relative permissions: the context-owner access checkbox.

import { describe, it, expect } from 'vitest';
import ContextOwnerAccessSection from './ContextOwnerAccessSection';
import AuthSettingsPage from '@ui/components/AuthSettingsPage';
import RolesPermissionsTab from './RolesPermissionsTab';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent, within } from '@ui/test-utils/renderWithProviders';

const LABEL = /Context owners — people who are Accountable or Responsible/;
const MCP_LABEL = /Context owners may also use the MCP server/;

// A stand-in for the API that remembers what was saved, so the checkbox has to
// re-read the server's answer rather than trust its own click.
function server({ enabled = false, mcp = false, failPut = false } = {}) {
  const state = { enabled, mcp };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    if (!String(url).includes('/api/admin/context-owner-access')) return undefined;
    if (opts.method === 'PUT') {
      if (failPut) return jsonResponse({ error: 'Insufficient permissions' }, { ok: false, status: 403 });
      Object.assign(state, JSON.parse(opts.body));
    }
    return { enabled: state.enabled, mcp: state.mcp };
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

  describe('the MCP switch for context owners', () => {
    it('is disabled, and says why, while context-owner access is off', async () => {
      renderWithProviders(<ContextOwnerAccessSection />, { auth: { authFetch: server({ mcp: true }).authFetch } });
      const box = await screen.findByRole('checkbox', { name: MCP_LABEL });
      await waitFor(() => expect(box).toBeChecked());
      expect(box).toBeDisabled();
      expect(screen.getByText('Turn on context-owner access first.')).toBeInTheDocument();
    });

    it('turns on with a PUT { mcp: true } alone, leaving owner access as it is', async () => {
      const { authFetch, state } = server({ enabled: true });
      renderWithProviders(<ContextOwnerAccessSection />, { auth: { authFetch } });
      const box = await screen.findByRole('checkbox', { name: MCP_LABEL });
      await waitFor(() => expect(box).not.toBeDisabled());
      await userEvent.click(box);
      await waitFor(() => expect(screen.getByRole('checkbox', { name: MCP_LABEL })).toBeChecked());
      expect(JSON.parse(puts(authFetch)[0][1].body)).toEqual({ mcp: true });
      expect(state).toEqual({ enabled: true, mcp: true });
      expect(screen.getByText(/counts cover their part only/)).toBeInTheDocument();
    });

    it('turns off with { mcp: false }', async () => {
      const { authFetch } = server({ enabled: true, mcp: true });
      renderWithProviders(<ContextOwnerAccessSection />, { auth: { authFetch } });
      await waitFor(() => expect(screen.getByRole('checkbox', { name: MCP_LABEL })).not.toBeDisabled());
      await userEvent.click(screen.getByRole('checkbox', { name: MCP_LABEL }));
      await waitFor(() => expect(screen.getByRole('checkbox', { name: MCP_LABEL })).not.toBeChecked());
      expect(JSON.parse(puts(authFetch)[0][1].body)).toEqual({ mcp: false });
    });
  });

  it('sits on the Roles & Permissions tab, in its own Relative permissions section below the role table', async () => {
    const { authFetch } = server({ enabled: true });
    const all = makeAuthFetch((url, opts) => (String(url).includes('/api/admin/roles')
      ? { isCustom: false, groups: [], catalog: [], mapping: { Admin: ['*'] }, currentUser: { roles: ['Admin'] } }
      : authFetch(url, opts)));
    renderWithProviders(<RolesPermissionsTab />, { auth: { authFetch: all } });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: LABEL })).toBeChecked());
    const section = screen.getByRole('region', { name: 'Relative permissions' });
    expect(within(section).getByRole('checkbox', { name: LABEL })).toBeInTheDocument();
    expect(within(section).getByText(/Matrix-share recipients are not one of them/)).toBeInTheDocument();
    // Its own section, after the role table — not nested inside it.
    const table = await screen.findByRole('heading', { name: 'Roles & Permissions' });
    expect(section.contains(table)).toBe(false);
    expect(table.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is no longer on the Authentication page', async () => {
    const { authFetch } = server({ enabled: true });
    const all = makeAuthFetch((url, opts) => (String(url).includes('/api/admin/auth-settings')
      ? { enabled: true, tenantId: 't', clientId: 'c', requiredRoles: [] }
      : authFetch(url, opts)));
    renderWithProviders(<AuthSettingsPage />, { auth: { authFetch: all } });
    expect(await screen.findByText('ENABLED')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Relative permissions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: LABEL })).not.toBeInTheDocument();
    expect(all.mock.calls.some(([u]) => String(u).includes('/api/admin/context-owner-access'))).toBe(false);
  });
});
