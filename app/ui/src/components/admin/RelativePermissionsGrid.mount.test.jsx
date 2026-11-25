// @vitest-environment jsdom
//
// Admin → Roles & Permissions → Relative permissions: the grid of what an
// Accountable or Responsible gets, per thing they answer for.

import { describe, it, expect } from 'vitest';
import RelativePermissionsGrid from './RelativePermissionsGrid';
import AuthSettingsPage from '@ui/components/AuthSettingsPage';
import RolesPermissionsTab from './RolesPermissionsTab';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent, within } from '@ui/test-utils/renderWithProviders';

const SUBJECTS = [
  { subject: 'OrganizationalUnit', kind: 'context', capabilities: ['view', 'subUnits', 'mcp'] },
  { subject: 'LogicalApplication', kind: 'context', capabilities: ['view', 'subUnits', 'mcp'] },
  { subject: 'BusinessRole', kind: 'businessRole', capabilities: ['view', 'review'] },
];
const off = (caps) => Object.fromEntries(caps.map(c => [c, false]));
const emptyPolicy = () => Object.fromEntries(SUBJECTS.map(s => [s.subject, { Accountable: off(s.capabilities), Responsible: off(s.capabilities) }]));

// A stand-in for the API that keeps what was saved — and, like the real one,
// turns off subUnits/mcp where view is off — so the grid has to show the
// server's answer rather than its own click.
function server({ policy = emptyPolicy(), failPut = false } = {}) {
  const state = { policy };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    if (!String(url).includes('/api/admin/context-owner-access')) return undefined;
    if (opts.method === 'PUT') {
      if (failPut) return jsonResponse({ error: 'Insufficient permissions' }, { ok: false, status: 403 });
      state.policy = JSON.parse(opts.body).policy;
    }
    return { subjects: SUBJECTS, policy: state.policy };
  });
  return { authFetch, state };
}

const puts = (authFetch) => authFetch.mock.calls.filter(([, o]) => o?.method === 'PUT');
const box = (name) => screen.getByRole('checkbox', { name });
const ORG_ACC_VIEW = 'Organisation · Accountable · Sign in & view';
const ORG_ACC_MCP = 'Organisation · Accountable · MCP';
const ORG_RES_VIEW = 'Organisation · Responsible · Sign in & view';
const BR_RES_REVIEW = 'Business roles · Responsible · Composition review';

async function ready(authFetch) {
  renderWithProviders(<RelativePermissionsGrid />, { auth: { authFetch } });
  await waitFor(() => expect(box(ORG_ACC_VIEW)).not.toBeDisabled());
}

describe('RelativePermissionsGrid', () => {
  it('has a row for each role under each thing people answer for, and only the cells that apply', async () => {
    await ready(server().authFetch);
    expect(screen.getByRole('rowheader', { name: 'Organisation' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Applications' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Business roles' })).toBeInTheDocument();
    // 2 context rows × 2 roles × 3 + business roles 2 × 2
    expect(screen.getAllByRole('checkbox')).toHaveLength(16);
    expect(screen.queryByRole('checkbox', { name: 'Business roles · Accountable · MCP' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Organisation · Accountable · Composition review' })).not.toBeInTheDocument();
  });

  it('saves one tick as the whole grid, changing only that cell, and shows what the server saved', async () => {
    const { authFetch, state } = server();
    await ready(authFetch);
    await userEvent.click(box(ORG_ACC_VIEW));
    await waitFor(() => expect(box(ORG_ACC_VIEW)).toBeChecked());
    const sent = JSON.parse(puts(authFetch)[0][1].body).policy;
    expect(sent.OrganizationalUnit.Accountable).toEqual({ view: true, subUnits: false, mcp: false });
    expect(sent.OrganizationalUnit.Responsible.view).toBe(false);
    expect(sent.BusinessRole).toEqual(emptyPolicy().BusinessRole);
    expect(state.policy).toEqual(sent);
    // Responsible is its own row: still off
    expect(box(ORG_RES_VIEW)).not.toBeChecked();
  });

  it('keeps MCP and Sub-units locked until Sign in & view is on in that row', async () => {
    const { authFetch } = server();
    await ready(authFetch);
    expect(box(ORG_ACC_MCP)).toBeDisabled();
    expect(box(ORG_ACC_MCP)).toHaveAttribute('title', 'Needs Sign in & view in this row first');
    await userEvent.click(box(ORG_ACC_VIEW));
    await waitFor(() => expect(box(ORG_ACC_MCP)).not.toBeDisabled());
    expect(box(ORG_ACC_MCP)).not.toHaveAttribute('title');
  });

  it('turning Sign in & view off also turns that row\'s MCP and Sub-units off', async () => {
    const policy = emptyPolicy();
    policy.OrganizationalUnit.Accountable = { view: true, subUnits: true, mcp: true };
    const { authFetch } = server({ policy });
    await ready(authFetch);
    await waitFor(() => expect(box(ORG_ACC_MCP)).toBeChecked());
    await userEvent.click(box(ORG_ACC_VIEW));
    await waitFor(() => expect(box(ORG_ACC_VIEW)).not.toBeChecked());
    expect(JSON.parse(puts(authFetch)[0][1].body).policy.OrganizationalUnit.Accountable).toEqual({ view: false, subUnits: false, mcp: false });
    expect(box(ORG_ACC_MCP)).not.toBeChecked();
  });

  it('lets Composition review be ticked without Sign in & view', async () => {
    const { authFetch } = server();
    await ready(authFetch);
    expect(box(BR_RES_REVIEW)).not.toBeDisabled();
    await userEvent.click(box(BR_RES_REVIEW));
    await waitFor(() => expect(box(BR_RES_REVIEW)).toBeChecked());
    expect(JSON.parse(puts(authFetch)[0][1].body).policy.BusinessRole.Responsible).toEqual({ view: false, review: true });
  });

  it('shows the API\'s error and keeps the cell as it was when the save is refused', async () => {
    const { authFetch } = server({ failPut: true });
    await ready(authFetch);
    await userEvent.click(box(ORG_ACC_VIEW));
    expect(await screen.findByRole('alert')).toHaveTextContent('Insufficient permissions');
    expect(box(ORG_ACC_VIEW)).not.toBeChecked();
  });

  it('sits on the Roles & Permissions tab, in its own Relative permissions section below the role table', async () => {
    const { authFetch } = server();
    const all = makeAuthFetch((url, opts) => (String(url).includes('/api/admin/roles')
      ? { isCustom: false, groups: [], catalog: [], mapping: { Admin: ['*'] }, currentUser: { roles: ['Admin'] } }
      : authFetch(url, opts)));
    renderWithProviders(<RolesPermissionsTab />, { auth: { authFetch: all } });
    const section = await screen.findByRole('region', { name: 'Relative permissions' });
    expect(await within(section).findByRole('checkbox', { name: ORG_ACC_VIEW })).toBeInTheDocument();
    expect(within(section).getByText(/Matrix-share recipients are not one of them/)).toBeInTheDocument();
    const table = await screen.findByRole('heading', { name: 'Roles & Permissions' });
    expect(section.contains(table)).toBe(false);
    expect(table.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not on the Authentication page', async () => {
    const { authFetch } = server();
    const all = makeAuthFetch((url, opts) => (String(url).includes('/api/admin/auth-settings')
      ? { enabled: true, tenantId: 't', clientId: 'c', requiredRoles: [] }
      : authFetch(url, opts)));
    renderWithProviders(<AuthSettingsPage />, { auth: { authFetch: all } });
    expect(await screen.findByText('ENABLED')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Relative permissions' })).not.toBeInTheDocument();
    expect(all.mock.calls.some(([u]) => String(u).includes('/api/admin/context-owner-access'))).toBe(false);
  });
});
