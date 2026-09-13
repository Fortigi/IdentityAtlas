// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import RollupMatrixView from './RollupMatrixView';
import {
  renderWithProviders, makeAuthFetch, jsonResponse,
  screen, userEvent,
} from '@ui/test-utils/renderWithProviders';

// A non-trivial attribute roll-up: two resource rows, two group columns
// (departments), plus one business-role (SOLL) column. Cell counts come from
// `counts` (directCount/governedCount per resource|group).
function makeRollup(overrides = {}) {
  return {
    attribute: 'department',
    rollupContent: 'resources-and-roles',
    rollupKind: 'attribute',
    resources: [
      { resourceId: 'res-1', resourceDisplayName: 'Finance App', resourceDescription: 'Finance application' },
      { resourceId: 'res-2', resourceDisplayName: 'HR Portal', resourceDescription: 'HR portal' },
    ],
    groupValues: ['Engineering', 'Sales'],
    counts: [
      { resourceId: 'res-1', groupValue: 'Engineering', directCount: 5, governedCount: 2 },
      { resourceId: 'res-1', groupValue: 'Sales', directCount: 3, governedCount: 3 },
      { resourceId: 'res-2', groupValue: 'Engineering', directCount: 1, governedCount: 0 },
    ],
    businessRoles: [{ id: 'br-1', displayName: 'Finance Approver' }],
    roleCounts: [{ resourceId: 'res-1', roleId: 'br-1', count: 4 }],
    groupTotals: [
      { groupValue: 'Engineering', total: 20 },
      { groupValue: 'Sales', total: 10 },
    ],
    ...overrides,
  };
}

const baseFilter = {
  rowType: 'user',
  subject: { include: [], exclude: [] },
  resource: { include: [], exclude: [] },
};

// The child panels (MatrixFilterSummary, MatrixScopePanel) fire their own
// authFetch calls on mount; stub the ones we assert on and let the rest 404
// (those children tolerate a non-ok response).
function makeFetch(extra = {}) {
  return makeAuthFetch({
    '/api/matrix/saved-filters': [],
    '/api/matrix/scope-stats': jsonResponse({}),
    '/api/matrix/data': jsonResponse({
      data: [
        { memberId: 'u1', memberDisplayName: 'Alice Eng', resourceId: 'res-1', membershipType: 'Direct' },
        { memberId: 'u2', memberDisplayName: 'Bob Eng', resourceId: 'res-2', membershipType: 'Indirect' },
      ],
    }),
    ...extra,
  });
}

function renderView(props = {}, authFetch = makeFetch()) {
  const setManagedFilter = props.setManagedFilter || vi.fn();
  const onOpenDetail = props.onOpenDetail || vi.fn();
  const onFilterChange = props.onFilterChange || vi.fn();
  const onAdjustFilter = props.onAdjustFilter || vi.fn();
  const result = renderWithProviders(
    h(RollupMatrixView, {
      rollup: props.rollup || makeRollup(),
      filter: props.filter || baseFilter,
      counts: props.counts ?? null,
      managedFilter: props.managedFilter || 'all',
      setManagedFilter,
      shareUrl: 'https://example.test/matrix',
      refreshing: props.refreshing || false,
      onOpenDetail,
      onAdjustFilter,
      onFilterChange,
    }),
    { auth: { authFetch } },
  );
  return { ...result, setManagedFilter, onOpenDetail, onFilterChange, onAdjustFilter, authFetch };
}

describe('RollupMatrixView (mounted)', () => {
  it('renders resource rows, group columns and a business-role column', () => {
    renderView();
    // Resource rows.
    expect(screen.getByText('Finance App')).toBeInTheDocument();
    expect(screen.getByText('HR Portal')).toBeInTheDocument();
    // Group column headers.
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
    // Business-role (SOLL) column.
    expect(screen.getByText('Finance Approver')).toBeInTheDocument();
    // Helper text mentions the grouping attribute.
    expect(screen.getByText(/Roll-up by/i)).toBeInTheDocument();
  });

  it('shows cell counts and per-row totals', () => {
    renderView();
    // res-1 total = 5 + 3 = 8 direct; role count cell shows 4.
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    // Individual direct counts are rendered.
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows the refreshing indicator when refreshing', () => {
    renderView({ refreshing: true });
    expect(screen.getByText(/updating/i)).toBeInTheDocument();
  });

  it('toggles the managed filter (All / Governed / Non-governed)', async () => {
    const { setManagedFilter } = renderView();
    const user = userEvent.setup();
    await user.click(screen.getByText('Governed'));
    expect(setManagedFilter).toHaveBeenCalledWith('managed');
    await user.click(screen.getByText('Non-governed'));
    expect(setManagedFilter).toHaveBeenCalledWith('unmanaged');
  });

  it('renders governed counts when managedFilter=managed', () => {
    // In governed mode res-1 total = 2 + 3 = 5.
    renderView({ managedFilter: 'managed' });
    expect(screen.getByText('Finance App')).toBeInTheDocument();
    // Governed cell for res-1/Sales is 3.
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
  });

  it('opens a resource detail when a row label is clicked', async () => {
    const { onOpenDetail } = renderView();
    const user = userEvent.setup();
    await user.click(screen.getByText('Finance App'));
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'res-1', 'Finance App');
  });

  it('expands a group header into individual subjects via authFetch', async () => {
    const { authFetch } = renderView();
    const user = userEvent.setup();

    // The group header carries an expand button (▸). Click it.
    const expandBtn = screen.getByTitle(/Expand Engineering into users/i);
    await user.click(expandBtn);

    // The drill authFetch was issued against the matrix-data endpoint.
    expect(authFetch).toHaveBeenCalledWith(
      '/api/matrix/data',
      expect.objectContaining({ method: 'POST' }),
    );

    // The expanded subjects render as new sub-columns.
    expect(await screen.findByText('Alice Eng')).toBeInTheDocument();
    expect(screen.getByText('Bob Eng')).toBeInTheDocument();
  });

  it('renders an empty-state row when there are no resources', () => {
    renderView({ rollup: makeRollup({ resources: [], counts: [], businessRoles: [], roleCounts: [] }) });
    expect(screen.getByText(/No assignments match the current filter/i)).toBeInTheDocument();
  });

  // A context (org-tree) roll-up: columns are context nodes rather than plain
  // attribute values, and the drill path is navigable.
  describe('context roll-up (org tree)', () => {
    const contextRollup = (overrides = {}) => makeRollup({
      rollupKind: 'context',
      attribute: 'manager-hierarchy',
      groupValues: ['node-eng', 'node-sales'],
      counts: [
        { resourceId: 'res-1', groupValue: 'node-eng', directCount: 5, governedCount: 2 },
        { resourceId: 'res-2', groupValue: 'node-sales', directCount: 2, governedCount: 0 },
      ],
      groupTotals: [{ groupValue: 'node-eng', total: 20 }, { groupValue: 'node-sales', total: 9 }],
      nodes: [
        { id: 'node-eng', displayName: 'Acme · Engineering (Manager, Ada)', total: 20, childCount: 3, directMembers: 4, depth: 2, pathIds: ['root', 'node-eng'], pathNames: ['Acme', 'Acme · Engineering'] },
        { id: 'node-sales', displayName: 'Acme · Sales (Manager, Bo)', total: 9, childCount: 0, directMembers: 9, depth: 2, pathIds: ['root', 'node-sales'], pathNames: ['Acme', 'Acme · Sales'] },
      ],
      breadcrumb: [{ id: 'root', displayName: 'Acme' }, { id: 'node-eng', displayName: 'Acme · Engineering (Manager, Ada)' }],
      ...overrides,
    });

    it('labels the columns with the deepest org segment and shows the drill path', () => {
      renderView({ rollup: contextRollup() });
      expect(screen.getByText('Drill path:')).toBeInTheDocument();
      // Column headers use the short label, not the full "A · B (Manager)" path.
      expect(screen.getAllByText('Engineering').length).toBeGreaterThan(0);
      expect(screen.getByText('Sales')).toBeInTheDocument();
    });

    it('zooms out to an earlier step of the drill path', async () => {
      const { onFilterChange } = renderView({ rollup: contextRollup() });
      await userEvent.setup().click(screen.getByTitle('Zoom out to Acme'));
      expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ rollupPath: [] }));
    });

    it('zooms into a node that has sub-teams', async () => {
      const { onFilterChange } = renderView({ rollup: contextRollup() });
      await userEvent.setup().click(screen.getByTitle(/Zoom into Engineering/));
      expect(onFilterChange).toHaveBeenCalledWith(
        expect.objectContaining({ rollupPath: ['node-eng'] }),
      );
    });

    it('expands and collapses an org in place in the layered view', async () => {
      const { onFilterChange } = renderView({ rollup: contextRollup({ layered: true, maxDepth: 2 }) });
      const user = userEvent.setup();
      // The team header splits the team into its sub-teams…
      await user.click(screen.getByTitle(/Click to split Engineering into its 3 sub-teams/));
      expect(onFilterChange).toHaveBeenCalledWith(
        expect.objectContaining({ rollupExpanded: ['node-eng'] }),
      );
      // …and the merged ancestor header collapses the branch back.
      await user.click(screen.getAllByTitle(/Collapse Acme back into one column/)[0]);
      expect(onFilterChange).toHaveBeenCalledWith(
        expect.objectContaining({ rollupExpanded: [] }),
      );
    });
  });

  it('renders the roles-only variant with business roles on the rows', () => {
    renderView({
      rollup: makeRollup({
        rollupContent: 'roles-only',
        roleRows: [{ id: 'br-1', displayName: 'Finance Approver', description: 'Approves invoices' }],
        cells: [{ roleId: 'br-1', groupValue: 'Engineering', count: 7 }],
      }),
    });
    // Row noun switches to "Business role" and the role row renders.
    expect(screen.getByText('Finance Approver')).toBeInTheDocument();
    // The cell count (7) and the row total (also 7) both render.
    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
    expect(screen.getByText(/Business roles on the rows/i)).toBeInTheDocument();
  });
});
