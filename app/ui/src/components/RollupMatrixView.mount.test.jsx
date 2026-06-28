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
