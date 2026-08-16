// @vitest-environment jsdom
//
// Interaction tests for RollupMatrixView — the companion to the mount test.
//
// RollupMatrixView.mount.test.jsx renders the default (flat, attribute) shape and
// asserts on output. That leaves the component's other four rendering modes and
// most of its handlers unexecuted: this file drives them. The split is by intent,
// not by size — mount = "does the default shape render", this file = "do the
// modes and the handlers behave".
//
// Why it matters here specifically: this is the repo's only unit over the
// cyclomatic threshold (.ci/complexity-baseline.json, cc 28), and its branches
// are exactly these mode switches — layered vs flat, context vs attribute,
// percent vs count, governed vs non-governed. A high line-coverage number on a
// file like this means "we rendered one mode", not "we tested it".
//
// Clicks use fireEvent rather than userEvent: every control here is a plain
// onClick, and userEvent's pointer simulation over this component's large table
// is orders of magnitude slower without testing anything extra.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement as h } from 'react';
import RollupMatrixView from './RollupMatrixView';
import {
  renderWithProviders, makeAuthFetch, jsonResponse,
  screen, fireEvent, waitFor,
} from '@ui/test-utils/renderWithProviders';

// Real xlsx generation is exercised by exportRollupToExcel's own tests; here we
// only care that the view hands it a correctly shaped payload.
vi.mock('@ui/utils/exportRollupToExcel', () => ({
  exportRollupToExcel: vi.fn(async () => {}),
}));
import { exportRollupToExcel } from '@ui/utils/exportRollupToExcel';

const baseFilter = {
  rowType: 'user',
  subject: { include: [], exclude: [] },
  resource: { include: [], exclude: [] },
};

function makeFetch(extra = {}) {
  return makeAuthFetch({
    '/api/matrix/saved-filters': [],
    '/api/matrix/scope-stats': jsonResponse({}),
    ...extra,
  });
}

// Minimal two-resource / two-group attribute roll-up; individual tests override
// only the slice they exercise.
function makeRollup(overrides = {}) {
  return {
    attribute: 'department',
    rollupContent: 'resources-and-roles',
    rollupKind: 'attribute',
    resources: [
      { resourceId: 'res-1', resourceDisplayName: 'Finance App', resourceDescription: 'Finance' },
      { resourceId: 'res-2', resourceDisplayName: 'HR Portal', resourceDescription: 'HR' },
    ],
    groupValues: ['Engineering', 'Sales'],
    counts: [
      { resourceId: 'res-1', groupValue: 'Engineering', directCount: 10, governedCount: 4 },
      { resourceId: 'res-1', groupValue: 'Sales', directCount: 5, governedCount: 5 },
      { resourceId: 'res-2', groupValue: 'Engineering', directCount: 2, governedCount: 0 },
    ],
    businessRoles: [{ id: 'br-1', displayName: 'Finance Approver' }],
    roleCounts: [{ resourceId: 'res-1', roleId: 'br-1', count: 4 }],
    groupTotals: [
      { groupValue: 'Engineering', total: 20 },
      { groupValue: 'Sales', total: 0 },
    ],
    ...overrides,
  };
}

function renderView(props = {}, authFetch = makeFetch()) {
  const spies = {
    setManagedFilter: vi.fn(),
    onOpenDetail: vi.fn(),
    onFilterChange: vi.fn(),
    onAdjustFilter: vi.fn(),
  };
  const result = renderWithProviders(
    h(RollupMatrixView, {
      rollup: props.rollup || makeRollup(),
      filter: props.filter || baseFilter,
      counts: props.counts ?? null,
      managedFilter: props.managedFilter || 'all',
      shareUrl: props.shareUrl ?? 'https://example.test/matrix',
      refreshing: false,
      ...spies,
      ...props.overrides,
    }),
    { auth: { authFetch } },
  );
  return { ...result, ...spies, authFetch };
}

beforeEach(() => {
  exportRollupToExcel.mockClear();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RollupMatrixView — governed / non-governed cell arithmetic', () => {
  it('non-governed mode shows direct minus governed and drops the business-role column', () => {
    renderView({ managedFilter: 'unmanaged' });
    // res-1: Engineering 10-4=6, Sales 5-5=0 → the 6 shows twice, as the
    // Engineering cell and as the row total.
    expect(screen.getAllByText('6')).toHaveLength(2);
    // The SOLL (business-role) column is governed-only, so it is hidden here.
    expect(screen.queryByText('Finance Approver')).not.toBeInTheDocument();
  });

  it('never renders a negative cell when governed exceeds direct', () => {
    renderView({
      managedFilter: 'unmanaged',
      rollup: makeRollup({
        counts: [{ resourceId: 'res-1', groupValue: 'Engineering', directCount: 1, governedCount: 4 }],
      }),
    });
    expect(screen.queryByText('-3')).not.toBeInTheDocument();
  });

  it('governed mode sums the governed counts', () => {
    renderView({ managedFilter: 'managed' });
    // res-1 governed: 4 + 5 = 9.
    expect(screen.getByText('9')).toBeInTheDocument();
  });

  it('treats the "gaps" filter as "all" for cell arithmetic', () => {
    renderView({ managedFilter: 'gaps' });
    // res-1 all: 10 + 5 = 15.
    expect(screen.getByText('15')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RollupMatrixView — percent mode', () => {
  const percentFilter = { ...baseFilter, rollupMetric: 'percent' };

  it('renders each cell as a percentage of its group total', () => {
    renderView({ filter: percentFilter });
    // Engineering total 20: res-1 10/20 = 50%, res-2 2/20 = 10%.
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
  });

  it('falls back to the raw count when the group total is zero', () => {
    renderView({ filter: percentFilter });
    // Sales has total 0 — 5 cannot be a percentage of nothing, so show 5.
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.queryByText('Infinity%')).not.toBeInTheDocument();
    expect(screen.queryByText('NaN%')).not.toBeInTheDocument();
  });

  it('shows the per-group denominator in the column header', () => {
    renderView({ filter: percentFilter });
    expect(screen.getByTitle(/20 users in this group/i)).toBeInTheDocument();
  });

  it('says "identities" instead of "users" when rolling up identities', () => {
    renderView({ filter: { ...percentFilter, rowType: 'identity' } });
    expect(screen.getByTitle(/20 identities in this group/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RollupMatrixView — toolbar actions', () => {
  const writeText = vi.fn(async () => {});

  beforeEach(() => {
    writeText.mockClear().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText }, configurable: true, writable: true,
    });
  });
  afterEach(() => { delete navigator.clipboard; });

  it('copies the share URL to the clipboard', async () => {
    renderView();
    fireEvent.click(screen.getByTitle(/Copy shareable link/i));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://example.test/matrix'));
  });

  it('survives a clipboard permission failure without throwing', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    renderView();
    fireEvent.click(screen.getByTitle(/Copy shareable link/i));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // The grid is still on screen — the rejection was swallowed.
    expect(screen.getByText('Finance App')).toBeInTheDocument();
  });

  it('exports the on-screen grid, rows ordered busiest-first', async () => {
    renderView();
    fireEvent.click(screen.getByTitle(/Export matrix to Excel/i));

    await waitFor(() => expect(exportRollupToExcel).toHaveBeenCalledTimes(1));
    const payload = exportRollupToExcel.mock.calls[0][0];
    expect(payload.rowNoun).toBe('Resource');
    expect(payload.sheetName).toBe('Roll-up');
    expect(payload.fileName).toBe('matrix-rollup-department.xlsx');
    expect(payload.columns.map(c => c.label)).toEqual(['Engineering', 'Sales']);
    expect(payload.roleColumns).toEqual([{ id: 'br-1', label: 'Finance Approver' }]);
    // res-1 (15) outranks res-2 (2).
    expect(payload.rows.map(r => r.label)).toEqual(['Finance App', 'HR Portal']);
    expect(payload.rows[0].total).toBe(15);
    expect(payload.rows[0].cell('Engineering')).toBe(10);
    expect(payload.rows[0].roleCell('br-1')).toBe(4);
    expect(payload.rows[1].roleCell('br-1')).toBe(0);
  });

  it('sanitises the attribute name into the export filename', async () => {
    renderView({ rollup: makeRollup({ attribute: 'ext.cost centre/EU' }) });
    fireEvent.click(screen.getByTitle(/Export matrix to Excel/i));
    await waitFor(() => expect(exportRollupToExcel).toHaveBeenCalled());
    expect(exportRollupToExcel.mock.calls[0][0].fileName).toBe('matrix-rollup-ext.cost_centre_EU.xlsx');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RollupMatrixView — group drill-down', () => {
  const drillBody = {
    data: [
      { memberId: 'u1', memberDisplayName: 'Alice', resourceId: 'res-1', membershipType: 'Direct' },
      { memberId: 'u2', memberDisplayName: 'Bob', resourceId: 'res-2', membershipType: 'Indirect' },
    ],
  };

  it('scopes the drill query to the clicked attribute value', async () => {
    const authFetch = makeFetch({ '/api/matrix/data': jsonResponse(drillBody) });
    renderView({}, authFetch);

    fireEvent.click(screen.getByTitle(/Expand Engineering into users/i));
    await screen.findByText('Alice');

    const body = JSON.parse(authFetch.mock.calls.find(c => c[0] === '/api/matrix/data')[1].body);
    expect(body.filter.subject.include).toContainEqual({
      kind: 'attribute', field: 'department', values: ['Engineering'],
    });
    // A drill is a per-subject query — the roll-up must be cleared.
    expect(body.filter.rollup).toBeNull();
    expect(body.filter.rollupPath).toEqual([]);
  });

  it('collapses an expanded group again without re-fetching', async () => {
    const authFetch = makeFetch({ '/api/matrix/data': jsonResponse(drillBody) });
    renderView({}, authFetch);

    fireEvent.click(screen.getByTitle(/Expand Engineering into users/i));
    await screen.findByText('Alice');
    const callsAfterExpand = authFetch.mock.calls.length;

    fireEvent.click(screen.getByTitle(/Collapse Engineering/i));
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument());
    expect(authFetch.mock.calls.length).toBe(callsAfterExpand);
  });

  it('re-expands from cache instead of issuing a second query', async () => {
    const authFetch = makeFetch({ '/api/matrix/data': jsonResponse(drillBody) });
    renderView({}, authFetch);

    fireEvent.click(screen.getByTitle(/Expand Engineering into users/i));
    await screen.findByText('Alice');
    fireEvent.click(screen.getByTitle(/Collapse Engineering/i));
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument());

    const before = authFetch.mock.calls.filter(c => c[0] === '/api/matrix/data').length;
    fireEvent.click(screen.getByTitle(/Expand Engineering into users/i));
    await screen.findByText('Alice');
    expect(authFetch.mock.calls.filter(c => c[0] === '/api/matrix/data').length).toBe(before);
  });

  it('recovers from a failed drill — no column, no stuck spinner', async () => {
    // A truncated/garbled response: the request succeeds, parsing it does not.
    const authFetch = makeFetch({
      '/api/matrix/data': {
        ok: true, status: 200,
        json: async () => { throw new Error('unexpected end of JSON input'); },
      },
    });
    renderView({}, authFetch);

    fireEvent.click(screen.getByTitle(/Expand Engineering into users/i));

    // The toggle returns to its collapsed glyph and the grid still renders.
    await waitFor(() => expect(screen.getByTitle(/Expand Engineering into users/i)).toHaveTextContent('▸'));
    expect(screen.getByText('Finance App')).toBeInTheDocument();
  });

  it('opens a subject detail from an expanded person column', async () => {
    const authFetch = makeFetch({ '/api/matrix/data': jsonResponse(drillBody) });
    const { onOpenDetail } = renderView({}, authFetch);

    fireEvent.click(screen.getByTitle(/Expand Engineering into users/i));
    fireEvent.click(await screen.findByText('Alice'));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'u1', 'Alice');
  });

  it('routes an Identity-typed member to the identity detail page', async () => {
    const authFetch = makeFetch({
      '/api/matrix/data': jsonResponse({
        data: [{ memberId: 'i1', memberDisplayName: 'Carol', memberType: 'Identity', resourceId: 'res-1', membershipType: 'Direct' }],
      }),
    });
    const { onOpenDetail } = renderView({}, authFetch);

    fireEvent.click(screen.getByTitle(/Expand Engineering into users/i));
    fireEvent.click(await screen.findByText('Carol'));
    expect(onOpenDetail).toHaveBeenCalledWith('identity', 'i1', 'Carol');
  });

  it('reads drill members from the roles-only response shape', async () => {
    const authFetch = makeFetch({
      '/api/matrix/data': jsonResponse({
        drill: { members: [{ memberId: 'u9', memberDisplayName: 'Dave', roleId: 'br-1' }] },
      }),
    });
    renderView({
      rollup: makeRollup({
        rollupContent: 'roles-only',
        roleRows: [{ id: 'br-1', displayName: 'Finance Approver' }],
        cells: [{ roleId: 'br-1', groupValue: 'Engineering', count: 7 }],
      }),
    }, authFetch);

    fireEvent.click(screen.getByTitle(/Expand Engineering into users/i));
    expect(await screen.findByText('Dave')).toBeInTheDocument();
    // The roles-only drill keeps the roll-up intact and just flags drill=true.
    const body = JSON.parse(authFetch.mock.calls.find(c => c[0] === '/api/matrix/data')[1].body);
    expect(body.filter.drill).toBe(true);
  });

  it('opens a business-role detail from a SOLL column header', () => {
    const { onOpenDetail } = renderView();
    fireEvent.click(screen.getByText('Finance Approver'));
    expect(onOpenDetail).toHaveBeenCalledWith('access-package', 'br-1', 'Finance Approver');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RollupMatrixView — context mode (flat)', () => {
  const contextRollup = makeRollup({
    rollupKind: 'context',
    groupValues: ['n1', 'n2'],
    counts: [{ resourceId: 'res-1', groupValue: 'n1', directCount: 3, governedCount: 1 }],
    nodes: [
      { id: 'n1', displayName: 'Corp · Sales · EMEA (Manager, Ann Lee)', total: 30, directMembers: 4, childCount: 2 },
      { id: 'n2', displayName: 'Corp · Sales · APAC', total: 8, directMembers: 0, childCount: 0 },
    ],
    breadcrumb: [
      { id: 'root', displayName: 'Corp' },
      { id: 'sales', displayName: 'Corp · Sales' },
    ],
  });

  it('labels columns with the deepest org segment, manager suffix stripped', () => {
    renderView({ rollup: contextRollup });
    expect(screen.getByText('EMEA')).toBeInTheDocument();
    expect(screen.getByText('APAC')).toBeInTheDocument();
    expect(screen.queryByText(/Ann Lee/)).not.toBeInTheDocument();
  });

  it('zooms into a node by pushing it onto the drill path', () => {
    const { onFilterChange } = renderView({ rollup: contextRollup });
    fireEvent.click(screen.getByTitle(/Zoom into EMEA/i));
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ rollupPath: ['n1'] }));
  });

  it('offers zoom only for a node that has sub-teams', () => {
    renderView({ rollup: contextRollup });
    expect(screen.queryByTitle(/Zoom into APAC/i)).not.toBeInTheDocument();
  });

  it('offers the members toggle only for a node with direct members', () => {
    renderView({ rollup: contextRollup });
    expect(screen.getByTitle(/Show the 4 users directly in this team/i)).toBeInTheDocument();
    expect(screen.queryByTitle(/directly in this team/i).textContent).toBe('▸');
  });

  it('drills a context node by membership, not by attribute value', async () => {
    const authFetch = makeFetch({
      '/api/matrix/data': jsonResponse({ data: [{ memberId: 'u1', memberDisplayName: 'Alice', resourceId: 'res-1', membershipType: 'Direct' }] }),
    });
    renderView({ rollup: contextRollup }, authFetch);

    fireEvent.click(screen.getByTitle(/Show the 4 users directly in this team/i));
    await screen.findByText('Alice');

    const body = JSON.parse(authFetch.mock.calls.find(c => c[0] === '/api/matrix/data')[1].body);
    expect(body.filter.subject.include).toContainEqual({
      kind: 'context', contextId: 'n1', includeChildren: false,
    });
  });

  it('renders the drill breadcrumb and zooms out when a crumb is clicked', () => {
    const { onFilterChange } = renderView({ rollup: contextRollup });
    expect(screen.getByText(/Drill path/i)).toBeInTheDocument();
    // The last crumb is the current level (plain text); earlier ones are buttons.
    fireEvent.click(screen.getByTitle(/Zoom out to Corp$/));
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ rollupPath: [] }));
  });

  it('hides the breadcrumb when there is no drill path', () => {
    renderView({ rollup: makeRollup({ ...contextRollup, breadcrumb: [] }) });
    expect(screen.queryByText(/Drill path/i)).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RollupMatrixView — layered context hierarchy', () => {
  // maxDepth 3: level 0 is the shared ancestor (merged), level 1 is each team's
  // own level, level 2 sits below it.
  const layeredRollup = makeRollup({
    rollupKind: 'context',
    layered: true,
    maxDepth: 3,
    groupValues: ['n1', 'n2'],
    counts: [{ resourceId: 'res-1', groupValue: 'n1', directCount: 3, governedCount: 1 }],
    nodes: [
      { id: 'n1', displayName: 'EMEA', depth: 2, pathIds: ['root', 'n1'], pathNames: ['Corp', 'EMEA'], total: 30, directMembers: 4, childCount: 2 },
      { id: 'n2', displayName: 'APAC', depth: 2, pathIds: ['root', 'n2'], pathNames: ['Corp', 'APAC'], total: 8, directMembers: 0, childCount: 0 },
    ],
  });

  it('merges the shared ancestor into one spanning header cell', () => {
    renderView({ rollup: layeredRollup });
    const ancestor = screen.getByTitle(/Collapse Corp back into one column/i);
    // Both teams share 'root' at level 0, so the cell spans both columns.
    expect(ancestor).toHaveAttribute('colspan', '2');
  });

  it('collapses an expanded branch from the ancestor row', () => {
    const { onFilterChange } = renderView({
      rollup: layeredRollup,
      filter: { ...baseFilter, rollupExpanded: ['root', 'other'] },
    });
    fireEvent.click(screen.getByTitle(/Collapse Corp back into one column/i));
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ rollupExpanded: ['other'] }));
  });

  it('splits a team into sub-teams from its own header level', () => {
    const { onFilterChange } = renderView({ rollup: layeredRollup });
    fireEvent.click(screen.getByTitle(/Click to split EMEA into its 2 sub-teams/i));
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ rollupExpanded: ['n1'] }));
  });

  it('does not re-add a team that is already expanded', () => {
    const { onFilterChange } = renderView({
      rollup: layeredRollup,
      filter: { ...baseFilter, rollupExpanded: ['n1'] },
    });
    fireEvent.click(screen.getByTitle(/Click to split EMEA into its 2 sub-teams/i));
    expect(onFilterChange).not.toHaveBeenCalled();
  });

  it('renders a leaf team as non-clickable with a plain count title', () => {
    renderView({ rollup: layeredRollup });
    expect(screen.getByTitle('APAC — 8 users')).toBeInTheDocument();
    expect(screen.queryByTitle(/split APAC/i)).not.toBeInTheDocument();
  });

  it('shows direct members over subtree total in the team header', () => {
    renderView({ rollup: layeredRollup });
    expect(screen.getByTitle(/4 users directly in this team · 30 in the whole subtree/i)).toBeInTheDocument();
  });

  it('expands a team\'s people without leaving the current level', async () => {
    const authFetch = makeFetch({
      '/api/matrix/data': jsonResponse({ data: [{ memberId: 'u1', memberDisplayName: 'Alice', resourceId: 'res-1', membershipType: 'Direct' }] }),
    });
    renderView({ rollup: layeredRollup }, authFetch);

    fireEvent.click(screen.getByTitle(/Show the 4 users directly in this team with a Direct assignment/i));
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    // Expanding members must not have changed the drill path.
    expect(screen.getByTitle(/Click to split EMEA into its 2 sub-teams/i)).toBeInTheDocument();
  });

  it('describes the layered org-chart reading rules', () => {
    renderView({ rollup: layeredRollup });
    expect(screen.getByText(/Manager Hierarchy/)).toBeInTheDocument();
    expect(screen.getByText(/split it into its sub-teams/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RollupMatrixView — layered attribute folds', () => {
  // 'Amsterdam' sits at its own (deepest) level; 'Sales' is folded — its depth is
  // shallower than maxDepth, so it renders as a single count column.
  const foldRollup = makeRollup({
    rollupKind: 'context',
    layered: true,
    layeredAttributes: true,
    maxDepth: 2,
    groupValues: ['a1', 'a2'],
    counts: [{ resourceId: 'res-1', groupValue: 'a1', directCount: 3, governedCount: 1 }],
    nodes: [
      { id: 'a1', displayName: 'Amsterdam', depth: 2, pathIds: ['dept-eng', 'loc-ams'], pathNames: ['Engineering', 'Amsterdam'], total: 12, childCount: 0 },
      { id: 'a2', displayName: 'Sales', depth: 1, pathIds: ['dept-sales'], pathNames: ['Sales'], total: 20, childCount: 4 },
    ],
  });

  it('folds an ancestor attribute level into a single column', () => {
    const { onFilterChange } = renderView({ rollup: foldRollup });
    fireEvent.click(screen.getByTitle(/Click to fold Engineering/i));
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ rollupCollapsed: ['dept-eng'] }));
  });

  it('folds a leaf value up to its parent group', () => {
    const { onFilterChange } = renderView({ rollup: foldRollup });
    fireEvent.click(screen.getByTitle(/Amsterdam — 12 users · click to fold this group/i));
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ rollupCollapsed: ['dept-eng'] }));
  });

  it('unfolds a folded group back into its values', () => {
    const { onFilterChange } = renderView({
      rollup: foldRollup,
      filter: { ...baseFilter, rollupCollapsed: ['a2', 'keep'] },
    });
    fireEvent.click(screen.getByTitle(/click to unfold Sales into its 4 values \(20 users\)/i));
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ rollupCollapsed: ['keep'] }));
  });

  it('does not re-fold a group that is already folded', () => {
    const { onFilterChange } = renderView({
      rollup: foldRollup,
      filter: { ...baseFilter, rollupCollapsed: ['dept-eng'] },
    });
    fireEvent.click(screen.getByTitle(/Click to fold Engineering/i));
    expect(onFilterChange).not.toHaveBeenCalled();
  });

  it('describes the attribute-fold reading rules', () => {
    renderView({ rollup: foldRollup });
    expect(screen.getByText(/Click a value/i)).toBeInTheDocument();
    expect(screen.getByText(/fold its group into a single count column/i)).toBeInTheDocument();
  });

  it('renders an empty header cell for a column with no matching node', () => {
    renderView({ rollup: makeRollup({ ...foldRollup, groupValues: ['a1', 'ghost'] }) });
    // The unknown column still renders (blank) rather than crashing the header.
    expect(screen.getByText('Finance App')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('RollupMatrixView — row cap', () => {
  it('caps the table at 300 rows and says how many were hidden', () => {
    const resources = Array.from({ length: 305 }, (_, i) => ({
      resourceId: `r${i}`, resourceDisplayName: `Resource ${i}`, resourceDescription: '',
    }));
    const counts = resources.map((r, i) => ({
      resourceId: r.resourceId, groupValue: 'Engineering', directCount: 305 - i, governedCount: 0,
    }));
    renderView({ rollup: makeRollup({ resources, counts, groupValues: ['Engineering'], businessRoles: [], roleCounts: [] }) });

    expect(screen.getByText(/Showing the top 300 of 305 resources by count/i)).toBeInTheDocument();
    // Busiest first: Resource 0 is rendered, the 5 smallest are cut.
    expect(screen.getByText('Resource 0')).toBeInTheDocument();
    expect(screen.queryByText('Resource 304')).not.toBeInTheDocument();
  });
});
