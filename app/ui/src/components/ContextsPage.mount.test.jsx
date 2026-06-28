// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import ContextsPage from './ContextsPage';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  within,
  waitFor,
  userEvent,
} from '@ui/test-utils/renderWithProviders';

// Two root trees: a generated one (selectable, deletable, syncable) and a
// synced one (delete blocked by API). The first root auto-selects on load.
const roots = {
  data: [
    {
      id: 'root-gen',
      displayName: 'Engineering Org',
      variant: 'generated',
      targetType: 'Identity',
      contextType: 'ManagerHierarchy',
      directMemberCount: 1,
      totalMemberCount: 4,
    },
    {
      id: 'root-synced',
      displayName: 'Sales OUs',
      variant: 'synced',
      targetType: 'Identity',
      contextType: 'OrgUnit',
      directMemberCount: 0,
      totalMemberCount: 9,
    },
  ],
};

// Subtree for root-gen: a single root node with two children (returned as an
// ARRAY of nodes, per /api/contexts/tree).
const genSubtree = [
  {
    id: 'root-gen',
    displayName: 'Engineering Org',
    variant: 'generated',
    targetType: 'Identity',
    contextType: 'ManagerHierarchy',
    directMemberCount: 1,
    totalMemberCount: 4,
    children: [
      {
        id: 'child-backend',
        displayName: 'Backend Squad',
        variant: 'generated',
        targetType: 'Identity',
        contextType: 'ManagerHierarchy',
        directMemberCount: 2,
        totalMemberCount: 2,
        children: [],
      },
      {
        id: 'child-frontend',
        displayName: 'Frontend Squad',
        variant: 'generated',
        targetType: 'Identity',
        contextType: 'ManagerHierarchy',
        directMemberCount: 1,
        totalMemberCount: 1,
        children: [],
      },
    ],
  },
];

// Order matters: /api/contexts/tree must be keyed before the bare /api/contexts
// roots key (most-specific first).
function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/contexts/tree': genSubtree,
    '/api/contexts': roots,
    ...overrides,
  });
}

describe('ContextsPage (mounted)', () => {
  it('loads roots, auto-selects the first, and renders its subtree', async () => {
    renderWithProviders(h(ContextsPage, {}), { auth: { authFetch: routes() } });

    // Left selector lists both roots.
    expect(await screen.findByText('Sales OUs')).toBeInTheDocument();

    // First root auto-selected → header + subtree children render on the right.
    expect(await screen.findByText('Backend Squad')).toBeInTheDocument();
    expect(screen.getByText('Frontend Squad')).toBeInTheDocument();

    // SelectedRootHeader shows the generated tree's Sync + Delete affordances.
    expect(screen.getByText('Sync')).toBeInTheDocument();
    expect(screen.getByText('Delete tree…')).toBeInTheDocument();
  });

  it('toggles between tree and list view modes', async () => {
    renderWithProviders(h(ContextsPage, {}), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Backend Squad');

    // Switch to list view — the list view renders a name filter input.
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(await screen.findByPlaceholderText('Filter by name…')).toBeInTheDocument();
    expect(screen.getByText(/nodes$/)).toBeInTheDocument();

    // Switch back to tree view.
    await user.click(screen.getByRole('button', { name: 'Tree' }));
    expect(await screen.findByText('Backend Squad')).toBeInTheDocument();
  });

  it('selecting the synced root hides the sync/delete affordances', async () => {
    renderWithProviders(h(ContextsPage, {}), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Sales OUs');
    await user.click(screen.getByText('Sales OUs'));

    // Synced trees: no Sync (only generated) and no Delete (API blocks it).
    expect(await screen.findByRole('button', { name: 'Tree' })).toBeInTheDocument();
    expect(screen.queryByText('Sync')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete tree…')).not.toBeInTheDocument();
  });

  it('runs the delete-tree confirm flow and calls DELETE', async () => {
    const authFetch = routes();
    renderWithProviders(h(ContextsPage, {}), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Backend Squad');

    // Click "Delete tree…" → inline confirm appears.
    await user.click(screen.getByText('Delete tree…'));
    expect(await screen.findByText('Yes, delete')).toBeInTheDocument();

    // Cancel first to exercise that branch.
    await user.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Yes, delete')).not.toBeInTheDocument();

    // Re-open and confirm.
    await user.click(screen.getByText('Delete tree…'));
    await user.click(await screen.findByText('Yes, delete'));

    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/contexts/root-gen'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('surfaces a delete error when the API rejects', async () => {
    // Function handler so the DELETE (a bare /api/contexts/root-gen URL) is
    // matched before the more-general /api/contexts roots stub.
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (opts.method === 'DELETE') {
        return jsonResponse({ error: 'tree is synced' }, { ok: false, status: 409 });
      }
      if (String(url).includes('/api/contexts/tree')) return genSubtree;
      if (String(url).includes('/api/contexts')) return roots;
      return jsonResponse({}, { ok: false, status: 404 });
    });
    renderWithProviders(h(ContextsPage, {}), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Backend Squad');
    await user.click(screen.getByText('Delete tree…'));
    await user.click(await screen.findByText('Yes, delete'));

    expect(await screen.findByText('tree is synced')).toBeInTheDocument();
  });

  it('opens the New Context wizard from the selector', async () => {
    renderWithProviders(h(ContextsPage, {}), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Sales OUs');
    await user.click(screen.getByRole('button', { name: '+ New' }));

    // The wizard modal opens (its heading is "New context tree").
    expect(await screen.findByText('New context tree')).toBeInTheDocument();
  });

  it('forwards a node click to onOpenDetail', async () => {
    const onOpenDetail = vi.fn();
    renderWithProviders(h(ContextsPage, { onOpenDetail }), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    // In list view the node name is a plain button → easiest to click.
    await screen.findByText('Backend Squad');
    await user.click(screen.getByRole('button', { name: 'List' }));

    const row = await screen.findByRole('button', { name: 'Backend Squad' });
    await user.click(row);

    expect(onOpenDetail).toHaveBeenCalledWith('context', 'child-backend', 'Backend Squad');
  });

  it('shows the roots-load error branch', async () => {
    const authFetch = makeAuthFetch({
      '/api/contexts': jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
    });
    renderWithProviders(h(ContextsPage, {}), { auth: { authFetch } });

    // Hook sets the error message to "HTTP 500"; the right pane renders it.
    expect(await screen.findByText('HTTP 500')).toBeInTheDocument();
    // With no roots + not loading, the empty-state prompt shows.
    expect(screen.getByText(/Select a tree on the left/i)).toBeInTheDocument();
  });

  it('runs the Sync flow on a generated tree', async () => {
    // POST /sync returns no runId → the poll loop is skipped, refresh runs,
    // and the "Synced" confirmation appears.
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (String(url).includes('/sync') && opts.method === 'POST') return { ok: true };
      if (String(url).includes('/api/contexts/tree')) return genSubtree;
      if (String(url).includes('/api/contexts')) return roots;
      return jsonResponse({}, { ok: false, status: 404 });
    });
    renderWithProviders(h(ContextsPage, {}), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Backend Squad');
    await user.click(screen.getByRole('button', { name: /Sync/i }));

    // The green "Synced" confirmation appears (distinct from the "Synced"
    // variant-filter option / badge — match the green status class).
    await waitFor(() => {
      const synced = screen.getAllByText('Synced').find(el =>
        el.className.includes('text-green-700'),
      );
      expect(synced).toBeTruthy();
    });
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/contexts/root-gen/sync'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('lazy-loads a node\'s members when its member toggle is expanded', async () => {
    const memberData = {
      total: 1,
      data: [{ id: 'u-1', displayName: 'Ada Lovelace', principalType: 'User' }],
    };
    const authFetch = makeAuthFetch((url) => {
      if (String(url).includes('/members')) return memberData;
      if (String(url).includes('/api/contexts/tree')) return genSubtree;
      if (String(url).includes('/api/contexts')) return roots;
      return jsonResponse({}, { ok: false, status: 404 });
    });
    renderWithProviders(h(ContextsPage, {}), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Backend Squad');

    // Several nodes have members → toggle the first (the root node).
    const memberToggles = screen.getAllByTitle(/Show the users directly in this context/i);
    await user.click(memberToggles[0]);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/contexts/root-gen/members'),
    );
  });

  it('shows the empty state when there are no roots', async () => {
    const authFetch = makeAuthFetch({
      '/api/contexts/tree': genSubtree,
      '/api/contexts': { data: [] },
    });
    const { container } = renderWithProviders(h(ContextsPage, {}), { auth: { authFetch } });

    expect(await screen.findByText(/Select a tree on the left/i)).toBeInTheDocument();
    // No root header rendered.
    expect(within(container).queryByText('Delete tree…')).not.toBeInTheDocument();
  });
});
