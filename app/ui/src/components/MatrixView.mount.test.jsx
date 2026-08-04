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
// `body.props` keeps the last props the grid body received, so tests can assert
// on the derived structures MatrixView hands it (SOLL mapping, row marking,
// folded-role tallies) without reimplementing the cell rendering here.
const body = vi.hoisted(() => ({ props: null }));
vi.mock('./matrix/SortableMatrixBody', () => ({
  default: (props) => {
    body.props = props;
    const { columnHeaders, orderedGroups = [] } = props;
    return h('table', null,
      columnHeaders,
      h('tbody', null,
        orderedGroups.map(g =>
          h('tr', { key: g.id }, h('td', null, h('span', { 'data-testid': 'row-label' }, g.displayName))),
        ),
      ),
    );
  },
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

// A matrix that contains a business role (br-1) granting one of the resource
// rows (res-1) — the shape the business-role fold operates on. res-2 is granted
// by no role, so it must survive every fold.
function makeRoleData() {
  return [
    ...makeData(),
    { memberId: 'u1', memberDisplayName: 'Alice Eng', department: 'Engineering', memberType: 'User', resourceId: 'br-1', resourceDisplayName: 'HR Manager Role', resourceType: 'BusinessRole', membershipType: 'Direct' },
  ];
}
const roleProps = {
  data: makeRoleData(),
  accessPackageGroups: [
    { accessPackageId: 'br-1', accessPackageName: 'HR Manager Role', resourceId: 'res-1', roleName: 'Member', totalAssignments: 1 },
  ],
  // Server-side business-role coverage: the role covers the resource it
  // Contains AND its own membership row (migration 061).
  managedByPackages: [
    { resourceId: 'res-1', memberId: 'u1', accessPackageIds: ['br-1'] },
    { resourceId: 'br-1', memberId: 'u1', accessPackageIds: ['br-1'] },
  ],
};

const rowLabels = () =>
  screen.queryAllByTestId('row-label').filter(el => el.isConnected).map(el => el.textContent);

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

  it('folds a business role\'s resources away and back from the toolbar', async () => {
    renderView(roleProps);
    const user = userEvent.setup();
    await expectRowVisible('HR Manager Role');
    await expectRowVisible('Finance App');

    await user.click(await screen.findByText('Fold roles'));
    // Only the role row and the resource no role grants remain.
    await waitFor(() => expect(rowLabels()).not.toContain('Finance App'));
    expect(rowLabels()).toContain('HR Manager Role');
    expect(rowLabels()).toContain('HR Portal');

    await user.click(await screen.findByText('Unfold roles'));
    await expectRowVisible('Finance App');
  });

  it('promotes the business-role row directly above the resources it grants', async () => {
    renderView(roleProps);
    await expectRowVisible('HR Manager Role');
    const labels = rowLabels();
    expect(labels.indexOf('HR Manager Role')).toBe(labels.indexOf('Finance App') - 1);
  });

  it('grants a business role its own SOLL cell, so its column is not blank on its own row', async () => {
    renderView(roleProps);
    await expectRowVisible('HR Manager Role');
    // Holding the role IS the assignment; the diagonal cell renders it as a
    // Member (D) grant in the role's own column.
    expect(body.props.apGroupMap.get('BR-1|br-1')).toBe('Member');
    expect(body.props.apGroupMap.get('RES-1|br-1')).toBe('Member');
  });

  it('keeps a business role\'s column when only its own row is on screen', async () => {
    renderView({
      ...roleProps,
      // The role grants a resource that is outside this matrix slice.
      accessPackageGroups: [
        { accessPackageId: 'br-1', accessPackageName: 'HR Manager Role', resourceId: 'res-99', roleName: 'Member', totalAssignments: 1 },
      ],
      managedByPackages: [{ resourceId: 'br-1', memberId: 'u1', accessPackageIds: ['br-1'] }],
    });
    await expectRowVisible('HR Manager Role');
    expect(body.props.accessPackages.map(ap => ap.id)).toEqual(['br-1']);
    expect(body.props.apGroupMap.get('BR-1|br-1')).toBe('Member');
  });

  it('shows the resources a role grants as that role\'s children', async () => {
    renderView(roleProps);
    await expectRowVisible('Finance App');
    const rows = new Map(body.props.orderedGroups.map(g => [g.displayName, g]));
    expect(rows.get('Finance App').roleParentId).toBe('BR-1');
    // A resource no role grants stays a plain top-level row.
    expect(rows.get('HR Portal').roleParentId).toBeUndefined();
  });

  it('tallies the access a folded role hides but does not grant', async () => {
    renderView(roleProps);
    const user = userEvent.setup();
    await expectRowVisible('Finance App');
    expect(body.props.roleExtraCounts).toBeNull();

    await user.click(await screen.findByText('Fold roles'));
    await waitFor(() => expect(body.props.roleExtraCounts).not.toBeNull());
    // Alice holds Finance App through the role — covered, so not counted.
    expect(body.props.roleExtraCounts.get('BR-1|u1')).toBeUndefined();
    // Bob's Indirect membership on the same resource is not covered by it.
    expect(body.props.roleExtraCounts.get('BR-1|u2')).toBe(1);
  });

  it('offers no fold controls in a matrix without business-role rows', async () => {
    renderView();
    await expectRowVisible('Finance App');
    expect(screen.queryByText('Fold roles')).not.toBeInTheDocument();
    expect(screen.queryByText('Unfold roles')).not.toBeInTheDocument();
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
