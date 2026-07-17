// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import RolesPermissionsSection from './RolesPermissionsSection';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

// Shape returned by GET /api/admin/roles.
function makeData(overrides = {}) {
  return {
    isCustom: false,
    groups: ['Read', 'Write'],
    catalog: [
      { key: 'dashboard.view', group: 'Read', label: 'View dashboard', description: 'See the landing page' },
      { key: 'users.read', group: 'Read', label: 'Read users', description: 'List user accounts' },
      { key: 'roles.write', group: 'Write', label: 'Edit roles', description: 'Change role mapping' },
      { key: 'orphan.perm', group: 'Other', label: 'Orphan', description: 'No matching group' },
    ],
    mapping: {
      Admin: ['*'],
      RoleMiner: ['dashboard.view', 'users.read'],
    },
    currentUser: { roles: ['Admin'], hasWildcard: true },
    ...overrides,
  };
}

// Simple GET-only stub (object form): every request to the roles endpoint
// returns the same mapping body.
function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/admin/roles': { ...makeData() },
    ...overrides,
  });
}

// Method-aware stub (top-level function form — the harness only invokes a
// function when it is the whole handler, never a per-key value). GET returns
// the mapping; PUT/DELETE return whatever `onMutate(method)` yields.
function methodRoutes(onMutate, data = makeData()) {
  return makeAuthFetch((url, opts = {}) => {
    const method = opts.method || 'GET';
    if (method === 'GET') return data;
    return onMutate(method);
  });
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'prompt').mockReturnValue('Servicedesk');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RolesPermissionsSection (mounted)', () => {
  it('shows a loading state then the matrix after the fetch resolves', async () => {
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch: routes() } });

    expect(await screen.findByText('Roles & Permissions')).toBeInTheDocument();
    // Role column headers ('Admin' also appears in the current-user badge, so
    // assert via the unambiguous role and the remove-role button title).
    expect(screen.getByText('RoleMiner')).toBeInTheDocument();
    expect(screen.getByTitle('Remove role "Admin"')).toBeInTheDocument();
    // Catalog rows grouped by section.
    expect(screen.getByText('View dashboard')).toBeInTheDocument();
    expect(screen.getByText('Edit roles')).toBeInTheDocument();
    // Group headers (incl. the orphan group appended from the catalog).
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.getByText('Orphan')).toBeInTheDocument();
    // Default-mapping badge + current-user badge.
    expect(screen.getByText('Default mapping')).toBeInTheDocument();
    expect(screen.getByText('Your sign-in includes:')).toBeInTheDocument();
  });

  it('renders the custom-mapping badge and "no roles" current-user state', async () => {
    const authFetch = routes({
      '/api/admin/roles': makeData({
        isCustom: true,
        currentUser: { roles: [], hasWildcard: false },
      }),
    });
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch } });

    expect(await screen.findByText('Custom mapping')).toBeInTheDocument();
    expect(screen.getByText('no roles in your token')).toBeInTheDocument();
  });

  it('surfaces a 403 permission error', async () => {
    const authFetch = makeAuthFetch({
      '/api/admin/roles': jsonResponse({ error: 'nope' }, { ok: false, status: 403 }),
    });
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch } });

    expect(await screen.findByText(/don't have permission to view the role mapping/i)).toBeInTheDocument();
  });

  it('surfaces a generic HTTP error', async () => {
    const authFetch = makeAuthFetch({
      '/api/admin/roles': jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
    });
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch } });

    expect(await screen.findByText('HTTP 500')).toBeInTheDocument();
  });

  it('toggling a permission enables Save and persists via PUT', async () => {
    const authFetch = methodRoutes(() => jsonResponse({ ok: true }));
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Roles & Permissions');

    // Tick a permission to make the draft dirty (the last checkbox is a perm
    // cell for the right-most role / row, never the wildcard toggle).
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[checkboxes.length - 1]);

    const saveBtn = screen.getByText('Save changes');
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);

    expect(authFetch).toHaveBeenCalledWith(
      '/api/admin/roles',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(await screen.findByText(/Saved\. Refresh other open browser tabs/i)).toBeInTheDocument();
  });

  it('re-fetches the mapping from the server after a successful save', async () => {
    // Pins the converted loader's reuse path: refresh() runs again after a PUT.
    let gets = 0;
    const authFetch = makeAuthFetch((url, opts = {}) => {
      const method = opts.method || 'GET';
      if (method === 'GET') { gets += 1; return makeData(); }
      return jsonResponse({ ok: true }); // PUT
    });
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch } });
    const user = userEvent.setup();
    await screen.findByText('Roles & Permissions');
    const afterMount = gets; // one GET from the mount load

    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[checkboxes.length - 1]);
    await user.click(screen.getByText('Save changes'));
    await screen.findByText(/Saved\. Refresh other open browser tabs/i);

    await waitFor(() => expect(gets).toBeGreaterThan(afterMount));
  });

  it('shows a save error message with hint when PUT fails', async () => {
    const authFetch = methodRoutes(() =>
      jsonResponse({ error: 'self-lockout', hint: 'keep admin.auth' }, { ok: false, status: 409 }),
    );
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Roles & Permissions');
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[checkboxes.length - 1]);
    await user.click(screen.getByText('Save changes'));

    expect(await screen.findByText('self-lockout')).toBeInTheDocument();
    expect(screen.getByText('keep admin.auth')).toBeInTheDocument();
  });

  it('Cancel reverts the draft and re-disables Save', async () => {
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Roles & Permissions');
    const saveBtn = screen.getByText('Save changes');
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[checkboxes.length - 1]);
    expect(saveBtn).not.toBeDisabled();

    await user.click(screen.getByText('Cancel'));
    expect(saveBtn).toBeDisabled();
  });

  it('toggling the wildcard checkbox for a role makes the draft dirty', async () => {
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Roles & Permissions');
    // The "all (*)" labels are the wildcard toggles per role.
    const wildcardLabels = screen.getAllByText('all (*)');
    await user.click(within(wildcardLabels[1].closest('label')).getByRole('checkbox'));

    expect(screen.getByText('Save changes')).not.toBeDisabled();
  });

  it('toggling a perm off a wildcard role expands it to the explicit catalog', async () => {
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Roles & Permissions');
    // Admin has '*'; its permission checkboxes are all checked. Click one to
    // expand the wildcard into an explicit list (exercises the '*' branch).
    const checkboxes = screen.getAllByRole('checkbox');
    // First permission checkbox for the Admin column (index varies; click an
    // effective/checked one that is part of the wildcard set).
    const checked = checkboxes.find((c) => c.checked && c.className.includes('opacity-60'));
    await user.click(checked);

    expect(screen.getByText('Save changes')).not.toBeDisabled();
  });

  it('Add role appends a new column and Remove role drops it', async () => {
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Roles & Permissions');
    await user.click(screen.getByText('+ Add role'));
    // Prompt is now an in-app modal: type the role name into its (autofocused)
    // input and confirm.
    await screen.findByText('Add role');
    await user.keyboard('Servicedesk');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Servicedesk')).toBeInTheDocument();

    // Remove the newly-added role via its ✕ button, then confirm in the dialog.
    const removeBtn = screen.getByTitle('Remove role "Servicedesk"');
    await user.click(removeBtn);
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(screen.queryByText('Servicedesk')).not.toBeInTheDocument();
  });

  it('Reset to defaults issues a DELETE and reports success', async () => {
    const authFetch = methodRoutes(() => jsonResponse({ ok: true }));
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Roles & Permissions');
    await user.click(screen.getByText('Reset to defaults'));
    // Confirm in the in-app dialog.
    await user.click(await screen.findByRole('button', { name: 'Reset' }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(
      '/api/admin/roles',
      expect.objectContaining({ method: 'DELETE' }),
    ));
    expect(await screen.findByText('Reverted to defaults.')).toBeInTheDocument();
  });

  it('Reset to defaults reports an error when DELETE fails', async () => {
    const authFetch = methodRoutes(() =>
      jsonResponse({ error: 'cannot reset' }, { ok: false, status: 500 }),
    );
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Roles & Permissions');
    await user.click(screen.getByText('Reset to defaults'));
    await user.click(await screen.findByRole('button', { name: 'Reset' }));

    expect(await screen.findByText('cannot reset')).toBeInTheDocument();
  });

  it('cancelling the Add-role dialog is a no-op', async () => {
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Roles & Permissions');
    const before = screen.getAllByText('all (*)').length;
    await user.click(screen.getByText('+ Add role'));
    // Dismiss the prompt dialog without entering anything (scope to the dialog
    // form — the page has its own Cancel buttons).
    const input = await screen.findByRole('textbox');
    await user.click(within(input.closest('form')).getByRole('button', { name: 'Cancel' }));
    expect(screen.getAllByText('all (*)')).toHaveLength(before);
  });

  it('shows the change-log audit trail (#786)', async () => {
    // The audit key is listed first so the substring matcher resolves
    // /api/admin/roles/audit before the shorter /api/admin/roles.
    const authFetch = makeAuthFetch({
      '/api/admin/roles/audit': {
        entries: [
          { id: 1, changedAt: '2026-07-01T10:00:00Z', changedBy: 'alice@example.com', action: 'save' },
          { id: 2, changedAt: '2026-06-30T09:00:00Z', changedBy: null, action: 'reset' },
        ],
      },
      '/api/admin/roles': makeData(),
    });
    renderWithProviders(h(RolesPermissionsSection), { auth: { authFetch } });

    expect(await screen.findByText('Recent changes')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('Saved mapping')).toBeInTheDocument();
    expect(screen.getByText('Reverted to defaults')).toBeInTheDocument();
    // A null actor (auth disabled) renders as the system label.
    expect(screen.getByText('system (auth off)')).toBeInTheDocument();
  });
});
