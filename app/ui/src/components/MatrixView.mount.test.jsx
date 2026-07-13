// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { render as rtlRender } from '@testing-library/react';
import MatrixView from './MatrixView';
import {
  renderWithProviders, makeAuthFetch, makeWrapper, jsonResponse,
  screen, userEvent, waitFor,
} from '@ui/test-utils/renderWithProviders';

// Stub the lazy-loaded virtual/DnD body so the test runner never pulls in
// @tanstack/react-virtual / @dnd-kit. The stub renders the real `columnHeaders`
// element MatrixView builds (exercising MatrixColumnHeaders) plus one labelled
// row per visible resource, so the orchestrator's column/sort/grouping wiring
// runs end to end.
vi.mock('./matrix/SortableMatrixBody', () => ({
  default: ({ columnHeaders, orderedGroups = [] }) =>
    h('table', null,
      columnHeaders,
      h('tbody', null,
        orderedGroups.map(g =>
          h('tr', { key: g.id }, h('td', null, h('span', { 'data-testid': 'row-label' }, g.displayName))),
        ),
      ),
    ),
}));

// A small but realistic matrix dataset: two resources, three subjects across two
// departments, a mix of membership types.
function makeData() {
  return [
    { memberId: 'u1', memberDisplayName: 'Alice Eng', department: 'Engineering', jobTitle: 'Dev', memberType: 'User', resourceId: 'res-1', resourceDisplayName: 'Finance App', membershipType: 'Direct' },
    { memberId: 'u2', memberDisplayName: 'Bob Eng', department: 'Engineering', jobTitle: 'Dev', memberType: 'User', resourceId: 'res-1', resourceDisplayName: 'Finance App', membershipType: 'Indirect' },
    { memberId: 'u3', memberDisplayName: 'Carol Sales', department: 'Sales', jobTitle: 'Rep', memberType: 'User', resourceId: 'res-2', resourceDisplayName: 'HR Portal', membershipType: 'Direct' },
    { memberId: 'u1', memberDisplayName: 'Alice Eng', department: 'Engineering', jobTitle: 'Dev', memberType: 'User', resourceId: 'res-2', resourceDisplayName: 'HR Portal', membershipType: 'Owner' },
  ];
}

const baseFilter = {
  rowType: 'user',
  subject: { include: [], exclude: [] },
  resource: { include: [], exclude: [] },
  sortAttributes: [{ attribute: 'department', dir: 'asc' }],
};

const counts = {
  subjectCount: 3, subjectTotal: 10, resourceCount: 2, resourceTotal: 5,
  assignmentCount: 4,
};

// Stub the mount-time fetches MatrixView and its panels fire; unmatched URLs
// 404, which all callers tolerate.
function makeFetch(extra = {}) {
  return makeAuthFetch({
    '/api/groups-with-nested': { groupIds: ['res-1'] },
    '/api/matrix/saved-filters': [],
    '/api/matrix/scope-stats': jsonResponse({}),
    '/api/group/': jsonResponse({ groups: [], memberships: [] }),
    ...extra,
  });
}

// Resource rows live in the lazy-mounted body, which appears a tick after the
// initial render. Re-query each poll (rather than holding a possibly-stale
// resolved node) and assert the row is actually connected to the document — a
// previous test's late-resolving lazy mount otherwise leaks a detached match.
async function expectRowVisible(text) {
  await waitFor(() => {
    const rows = screen.queryAllByTestId('row-label').filter(el => el.textContent === text && el.isConnected);
    expect(rows.length).toBeGreaterThan(0);
  });
}

function renderView(props = {}, authFetch = makeFetch()) {
  const setManagedFilter = props.setManagedFilter || vi.fn();
  const onOpenDetail = props.onOpenDetail || vi.fn();
  const onAdjustFilter = props.onAdjustFilter || vi.fn();
  const result = renderWithProviders(
    h(MatrixView, {
      data: 'data' in props ? props.data : makeData(),
      accessPackageGroups: props.accessPackageGroups || [],
      managedByPackages: props.managedByPackages || [],
      filter: 'filter' in props ? props.filter : baseFilter,
      counts: 'counts' in props ? props.counts : counts,
      managedFilter: props.managedFilter || 'all',
      setManagedFilter,
      groupTagMap: props.groupTagMap,
      refreshing: props.refreshing || false,
      shareUrl: 'https://example.test/matrix',
      onOpenDetail,
      onAdjustFilter,
      hasData: 'hasData' in props ? props.hasData : true,
    }),
    { auth: { authFetch } },
  );
  return { ...result, setManagedFilter, onOpenDetail, onAdjustFilter, authFetch };
}

describe('MatrixView (mounted)', () => {
  it('fetches nested-group metadata on mount and renders the toolbar', async () => {
    const { authFetch } = renderView();
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith('/api/groups-with-nested'),
    );
    // Toolbar view-mode toggle is always present.
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Governed')).toBeInTheDocument();
    expect(screen.getByText('Non-governed')).toBeInTheDocument();
  });

  it('renders resource rows and subject columns from the data prop', async () => {
    renderView();
    // Resource rows (from the stubbed body) — only groups with members show.
    await expectRowVisible('Finance App');
    await expectRowVisible('HR Portal');
    // Subject column headers (real MatrixColumnHeaders), grouped by department.
    expect(screen.getAllByText('Alice Eng').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Carol Sales').length).toBeGreaterThan(0);
  });

  it('shows the filter summary and scope panel when a filter is applied', () => {
    renderView();
    // Filter summary chip: rows axis label.
    expect(screen.getByText(/× Resource/i)).toBeInTheDocument();
  });

  it('shows the legend and no empty-state when a filter is applied', () => {
    renderView();
    expect(screen.queryByText(/Pick a slice to inspect/i)).not.toBeInTheDocument();
  });

  it('renders the "pick a slice" empty state when no filter is applied', () => {
    renderView({ filter: null });
    expect(screen.getByText(/Pick a slice to inspect/i)).toBeInTheDocument();
  });

  it('invokes onAdjustFilter from the empty-state Create matrix button', async () => {
    const { onAdjustFilter } = renderView({ filter: null });
    const user = userEvent.setup();
    await user.click(screen.getByText('Create matrix'));
    expect(onAdjustFilter).toHaveBeenCalled();
  });

  it('renders the "no data available" empty state when hasData is false', () => {
    renderView({ filter: null, hasData: false });
    expect(screen.getByText(/No data available yet/i)).toBeInTheDocument();
  });

  it('renders the no-matching-assignments message when data is empty', () => {
    renderView({ data: [] });
    expect(screen.getByText(/No assignments match the current filter/i)).toBeInTheDocument();
  });

  it('shows the refreshing overlay when refreshing', async () => {
    renderView({ refreshing: true });
    expect(await screen.findByText(/Updating/i)).toBeInTheDocument();
  });

  it('forwards toolbar view-mode toggles to setManagedFilter', async () => {
    const { setManagedFilter } = renderView();
    const user = userEvent.setup();
    await user.click(screen.getByText('Governed'));
    expect(setManagedFilter).toHaveBeenCalledWith('managed');
    await user.click(screen.getByText('Non-governed'));
    expect(setManagedFilter).toHaveBeenCalledWith('unmanaged');
  });

  it('applies the governed (managed) client-side filter without crashing', async () => {
    // managedByPackages covers res-1|u1, so governed view keeps that pair.
    renderView({
      managedFilter: 'managed',
      managedByPackages: [
        { resourceId: 'res-1', memberId: 'u1', accessPackageIds: ['ap-1'] },
      ],
    });
    await expectRowVisible('Finance App');
  });

  it('renders the non-governed view (managedFilter=unmanaged)', async () => {
    renderView({ managedFilter: 'unmanaged' });
    await expectRowVisible('Finance App');
  });

  it('fetches hierarchy paths when a sort-hierarchy is selected', async () => {
    const hierFetch = makeFetch({
      '/api/matrix/hierarchy-paths': jsonResponse({
        paths: { u1: ['Org · Engineering'], u3: ['Org · Sales'] },
        depth: 1,
      }),
    });
    const filter = { ...baseFilter, sortHierarchy: { contextId: 'ctx-1' } };
    const { authFetch } = renderView({ filter }, hierFetch);
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        '/api/matrix/hierarchy-paths',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('uses a group tag map without error', async () => {
    const groupTagMap = new Map([['RES-1', [{ name: 'pii', color: '#abc' }]]]);
    renderView({ groupTagMap });
    await expectRowVisible('Finance App');
  });

  it('forwards the active resource filter to the nested-groups fetch on Expand All', async () => {
    // A resource-type-scoped matrix: expanding must POST that scope so the
    // backend constrains nested resources to it (regression: #674).
    const filter = {
      ...baseFilter,
      resource: { include: [{ kind: 'attribute', field: 'resourceType', values: ['Group'] }] },
    };
    const { authFetch } = renderView({ filter });
    const user = userEvent.setup();
    // Wait for the mount-time groups-with-nested fetch so Expand All renders.
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/groups-with-nested'));
    await user.click(await screen.findByText('Expand All'));
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/group/res-1/nested-groups'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('resourceType'),
        }),
      ),
    );
  });

  it('clears expanded nesting when the matrix filter changes (#674)', async () => {
    // Nested data is scoped to the resource filter, so a filter change must drop
    // any expansion (else stale nested rows from the old scope would linger).
    // Render through makeWrapper so rerender preserves the same component
    // instance (and its expand state) across the prop change.
    const authFetch = makeFetch();
    const { wrapper } = makeWrapper({ auth: { authFetch } });
    const el = (filter) => h(MatrixView, {
      data: makeData(), accessPackageGroups: [], managedByPackages: [],
      filter, counts, managedFilter: 'all', setManagedFilter: vi.fn(),
      refreshing: false, shareUrl: 'https://example.test/matrix',
      onOpenDetail: vi.fn(), onAdjustFilter: vi.fn(), hasData: true,
    });
    const user = userEvent.setup();
    const { rerender } = rtlRender(el(baseFilter), { wrapper });
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/groups-with-nested'));
    await user.click(await screen.findByText('Expand All'));
    // Collapse All only renders while something is expanded.
    await screen.findByText('Collapse All');
    // Change the filter → render-time reset collapses the nesting.
    rerender(el({
      ...baseFilter,
      resource: { include: [{ kind: 'attribute', field: 'resourceType', values: ['Group'] }] },
    }));
    await waitFor(() => expect(screen.queryByText('Collapse All')).not.toBeInTheDocument());
  });
});
