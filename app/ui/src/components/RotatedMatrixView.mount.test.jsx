// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import RotatedMatrixView from './RotatedMatrixView';
import {
  renderWithProviders, makeAuthFetch, jsonResponse,
  screen, within, userEvent,
} from '@ui/test-utils/renderWithProviders';

// Subjects-as-rows data: two users, two resources of one type plus one of
// another, with a mix of membership types and a governed cell.
function makeData() {
  return [
    {
      memberId: 'u1', memberDisplayName: 'Alice Eng', department: 'Engineering',
      jobTitle: 'Developer', resourceId: 'res-1', resourceDisplayName: 'Finance App',
      resourceType: 'Group', systemName: 'EntraID', membershipType: 'Direct',
      managedByAccessPackage: true,
    },
    {
      memberId: 'u1', memberDisplayName: 'Alice Eng', department: 'Engineering',
      jobTitle: 'Developer', resourceId: 'res-2', resourceDisplayName: 'HR Portal',
      resourceType: 'Group', systemName: 'EntraID', membershipType: 'Indirect',
    },
    {
      memberId: 'u2', memberDisplayName: 'Bob Sales', department: 'Sales',
      jobTitle: 'Rep', resourceId: 'res-3', resourceDisplayName: 'CRM Role',
      resourceType: 'EntraDirectoryRole', systemName: 'EntraID', membershipType: 'Direct',
    },
  ];
}

const baseFilter = {
  rowType: 'user',
  subject: { include: [], exclude: [] },
  resource: { include: [], exclude: [] },
};

// MatrixFilterSummary fetches saved-filters on mount; let it 404 gracefully
// or stub it. Most-specific first.
function makeFetch(extra = {}) {
  return makeAuthFetch({
    '/api/matrix/saved-filters': [],
    '/api/matrix/scope-stats': jsonResponse({}),
    ...extra,
  });
}

function renderView(props = {}, authFetch = makeFetch()) {
  const setManagedFilter = props.setManagedFilter || vi.fn();
  const onOpenDetail = props.onOpenDetail || vi.fn();
  const onAdjustFilter = props.onAdjustFilter || vi.fn();
  const result = renderWithProviders(
    h(RotatedMatrixView, {
      data: props.data || makeData(),
      filter: 'filter' in props ? props.filter : baseFilter,
      counts: props.counts ?? null,
      managedFilter: props.managedFilter || 'all',
      setManagedFilter,
      refreshing: props.refreshing || false,
      shareUrl: 'https://example.test/matrix',
      onOpenDetail,
      onAdjustFilter,
      hasData: props.hasData,
    }),
    { auth: { authFetch } },
  );
  return { ...result, setManagedFilter, onOpenDetail, onAdjustFilter, authFetch };
}

describe('RotatedMatrixView (mounted)', () => {
  it('renders subject rows and resource columns', () => {
    renderView();
    expect(screen.getByText('Alice Eng')).toBeInTheDocument();
    expect(screen.getByText('Bob Sales')).toBeInTheDocument();
    expect(screen.getByText('Finance App')).toBeInTheDocument();
    expect(screen.getByText('CRM Role')).toBeInTheDocument();
    // Sticky header labels.
    expect(screen.getByText('Display Name')).toBeInTheDocument();
    expect(screen.getByText('Department')).toBeInTheDocument();
    expect(screen.getByText('Job Title')).toBeInTheDocument();
  });

  it('renders the merged resource-type top header spans', () => {
    renderView();
    expect(screen.getByText('Group')).toBeInTheDocument();
    expect(screen.getByText('EntraDirectoryRole')).toBeInTheDocument();
  });

  it('shows the per-row department and job title values', () => {
    renderView();
    expect(screen.getByText('Developer')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
  });

  it('opens a subject detail when a row label is clicked', async () => {
    const { onOpenDetail } = renderView();
    const user = userEvent.setup();
    await user.click(screen.getByText('Alice Eng'));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'u1', 'Alice Eng');
  });

  it('opens a resource detail when a column header is clicked', async () => {
    const { onOpenDetail } = renderView();
    const user = userEvent.setup();
    await user.click(screen.getByText('CRM Role'));
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'res-3', 'CRM Role');
  });

  it('uses identity kind for the row click when rowType is identity', async () => {
    const { onOpenDetail } = renderView({
      filter: { ...baseFilter, rowType: 'identity' },
    });
    const user = userEvent.setup();
    await user.click(screen.getByText('Alice Eng'));
    expect(onOpenDetail).toHaveBeenCalledWith('identity', 'u1', 'Alice Eng');
  });

  it('toggles the managed filter from the toolbar', async () => {
    const { setManagedFilter } = renderView();
    const user = userEvent.setup();
    await user.click(screen.getByText('Governed'));
    expect(setManagedFilter).toHaveBeenCalledWith('managed');
  });

  it('shows an Excel-not-supported tip when export is clicked', async () => {
    renderView();
    const user = userEvent.setup();
    await user.click(screen.getByText('Export Excel'));
    expect(await screen.findByText(/Excel export is not yet supported/i)).toBeInTheDocument();
  });

  it('copies the share URL to the clipboard when Share Link is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // Define our own clipboard stub and drive the click with fireEvent so
    // userEvent's own clipboard shim doesn't intercept the write.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderView();
    fireEventClick(screen.getByText('Share Link'));
    expect(await screen.findByText('Copied!')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('https://example.test/matrix');
  });

  it('shows the refreshing overlay when refreshing', () => {
    renderView({ refreshing: true });
    expect(screen.getByText(/Updating/i)).toBeInTheDocument();
  });

  it('renders the managed-only view (governed cells survive the filter)', () => {
    renderView({ managedFilter: 'managed' });
    // Only Alice's res-1 row is managed; Bob and HR Portal drop out.
    expect(screen.getByText('Alice Eng')).toBeInTheDocument();
    expect(screen.queryByText('Bob Sales')).not.toBeInTheDocument();
    expect(screen.getByText('Finance App')).toBeInTheDocument();
  });

  it('renders the "pick a slice" empty state when no filter is applied', () => {
    const { onAdjustFilter } = renderView({ filter: null, hasData: true });
    expect(screen.getByText(/Pick a slice to inspect/i)).toBeInTheDocument();
    const btn = screen.getByText('Create matrix');
    fireEventClick(btn);
    expect(onAdjustFilter).toHaveBeenCalled();
  });

  it('renders the "no data available" empty state when hasData is false', () => {
    renderView({ filter: null, hasData: false });
    expect(screen.getByText(/No data available yet/i)).toBeInTheDocument();
  });

  it('renders the no-assignments message when data is empty', () => {
    renderView({ data: [] });
    expect(screen.getByText(/No assignments match the current matrix/i)).toBeInTheDocument();
  });

  it('renders one cell per resource column for each user row', () => {
    const { container } = renderView();
    // Alice's row has three resource cells (res-1/res-2/res-3).
    const aliceCell = screen.getByText('Alice Eng').closest('tr');
    expect(within(aliceCell).getAllByRole('cell').length).toBeGreaterThanOrEqual(6);
    expect(container.querySelector('table')).toBeInTheDocument();
  });
});

// Tiny helper so we don't need to import fireEvent just for one synchronous
// click in a non-async test.
function fireEventClick(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
