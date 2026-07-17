// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import AccessPackagesPage from './AccessPackagesPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, within, fireEvent, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const categories = [
  { id: 1, name: 'Finance', color: '#ef4444', assignmentCount: 3 },
  { id: 2, name: 'HR', color: '#3b82f6', assignmentCount: 1 },
];

const packages = [
  {
    id: 'ap1',
    displayName: 'Payroll Access',
    assignmentType: 'Auto-assigned',
    complianceStatus: 'Compliant',
    reviewDeadline: '2026-01-01T00:00:00Z',
    lastReviewDate: '2025-12-01T00:00:00Z',
    lastReviewedBy: 'alice',
    totalAssignments: 5,
    hasReviewConfigured: true,
    category: { id: 1, name: 'Finance', color: '#ef4444' },
  },
  {
    id: 'ap2',
    displayName: 'Recruiting Access',
    assignmentType: 'Request-based',
    complianceStatus: 'Missed',
    reviewDeadline: '2026-02-01T00:00:00Z',
    daysOverdue: 12,
    reviewerInfo: 'bob',
    missedReviewsCount: 2,
    lastReviewDate: null,
    lastReviewedBy: 'AAD Access Review (auto)',
    totalAssignments: 3,
    hasReviewConfigured: true,
    category: null,
  },
  {
    id: 'ap3',
    displayName: 'Onboarding Access',
    assignmentType: 'Both',
    complianceStatus: null,
    totalAssignments: 0,
    hasReviewConfigured: false,
    lastReviewDate: null,
    lastReviewedBy: null,
    category: null,
  },
];

function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/categories': categories,
    '/api/access-packages': { data: packages, total: packages.length },
    ...overrides,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // jsdom stubs for window dialogs used by category delete / alerts
  window.confirm = vi.fn(() => true);
  window.alert = vi.fn();
});

describe('AccessPackagesPage (mounted)', () => {
  it('shows the loading state then the loaded list', async () => {
    renderWithProviders(h(AccessPackagesPage, { onOpenDetail: () => {} }), { auth: { authFetch: routes() } });

    // Loading text shows before the mount-effect fetch resolves.
    expect(screen.getByText('Loading business roles...')).toBeInTheDocument();

    // Rows populate after fetch resolves.
    expect(await screen.findByText('Payroll Access')).toBeInTheDocument();
    expect(screen.getByText('Recruiting Access')).toBeInTheDocument();
    expect(screen.getByText('Onboarding Access')).toBeInTheDocument();

    // Total count in the header.
    expect(screen.getByText('3 total')).toBeInTheDocument();

    // Categories from /api/categories appear in the management bar.
    expect(screen.getByTitle(/3 business roles/i)).toBeInTheDocument();

    // Compliance variants render.
    expect(screen.getByText('Compliant')).toBeInTheDocument();
    expect(screen.getByText(/Missed/)).toBeInTheDocument();
    expect(screen.getByText('No assignments')).toBeInTheDocument();
    // Auto-completed reviewer badge.
    expect(screen.getByText('Auto')).toBeInTheDocument();
  });

  it('renders the empty state when no packages are returned', async () => {
    renderWithProviders(h(AccessPackagesPage), {
      auth: { authFetch: routes({ '/api/access-packages': { data: [], total: 0 } }) },
    });
    expect(await screen.findByText('No business roles found.')).toBeInTheDocument();
  });

  it('renders the export button (wildcard permission) and disables it while exporting', async () => {
    const authFetch = routes();
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });
    expect(await screen.findByText('Payroll Access')).toBeInTheDocument();
    const exportBtn = screen.getByRole('button', { name: 'Export Excel' });
    expect(exportBtn).toBeEnabled();
  });

  it('issues a search query (debounced) when typing in the search box', async () => {
    const authFetch = routes();
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Payroll Access');
    // Reachable by accessible name (aria-label), not just placeholder — #761.
    await user.type(screen.getByRole('textbox', { name: /Search business roles/i }), 'pay');

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('search=pay'));
    });
  });

  it('filters client-side by assignment type and shows the no-match empty state', async () => {
    const authFetch = routes();
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });

    await screen.findByText('Payroll Access');

    // Pick a type only ap1 matches -> the other rows drop out.
    // The type filter is the first combobox on the page (no rows selected yet).
    const typeSelect = screen.getAllByRole('combobox')[0];
    fireEvent.change(typeSelect, { target: { value: 'Auto-assigned' } });

    await waitFor(() => {
      expect(screen.queryByText('Recruiting Access')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Payroll Access')).toBeInTheDocument();
  });

  it('sends sortCol/sortDir when a sortable header is clicked', async () => {
    const authFetch = routes();
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Payroll Access');
    await user.click(screen.getByText('Name'));

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('sortCol=displayName'));
    });
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('sortDir=asc'));
  });

  it('filters by category when a category chip is clicked', async () => {
    const authFetch = routes();
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Payroll Access');
    // The category chip is a clickable span (has the assignment-count title).
    await user.click(screen.getByTitle(/3 business roles/i));

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('categoryId=1'));
    });

    // The "Clear all" button appears once a filter is active.
    expect(await screen.findByText('Clear all')).toBeInTheDocument();
  });

  it('filters by uncategorized', async () => {
    const authFetch = routes();
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Payroll Access');
    await user.click(screen.getByText('Uncategorized'));

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('uncategorized=true'));
    });
  });

  it('selects rows and shows the action bar, then assigns a category', async () => {
    const authFetch = routes();
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Payroll Access');

    // Row checkboxes: index 0 is the header select-all, 1..N are rows.
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[1]);

    expect(await screen.findByText('1 selected')).toBeInTheDocument();

    // Choose a category in the action bar and assign.
    const actionSelect = within(screen.getByText('1 selected').closest('div')).getByRole('combobox');
    await user.selectOptions(actionSelect, '1');
    await user.click(screen.getByRole('button', { name: 'Set Category' }));

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(
        '/api/categories/1/assign',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('select-all toggles selection for every row on the page', async () => {
    const authFetch = routes();
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Payroll Access');
    const headerCheckbox = screen.getAllByRole('checkbox')[0];
    await user.click(headerCheckbox);

    expect(await screen.findByText('3 selected')).toBeInTheDocument();

    // Remove category from the whole selection.
    await user.click(screen.getByRole('button', { name: 'Remove Category' }));
    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(
        '/api/categories/unassign',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('creates a new category', async () => {
    const authFetch = routes();
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Payroll Access');
    await user.click(screen.getByText('+ New Category'));

    await user.type(screen.getByPlaceholderText('Category name...'), 'Engineering');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(
        '/api/categories',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('deletes a category via the chip delete button', async () => {
    const authFetch = routes();
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Payroll Access');
    // Each chip has a "Delete category" titled button.
    const deleteBtns = screen.getAllByTitle('Delete category');
    await user.click(deleteBtns[0]);

    // Confirm via the in-app dialog (replaces the native confirm()).
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(
        '/api/categories/1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  it('assigns a category from the per-row dropdown', async () => {
    const authFetch = routes();
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Recruiting Access');

    // Per-row category selects: there are 3 (one per row) plus none in header.
    // Find the row for ap2 (Recruiting Access, currently None) and pick Finance.
    const row = screen.getByText('Recruiting Access').closest('tr');
    const rowSelect = within(row).getByRole('combobox');
    await user.selectOptions(rowSelect, '1');

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(
        '/api/categories/1/assign',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('opens detail when a package name button is clicked', async () => {
    const onOpenDetail = vi.fn();
    renderWithProviders(h(AccessPackagesPage, { onOpenDetail }), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Payroll Access' }));
    expect(onOpenDetail).toHaveBeenCalledWith('access-package', 'ap1', 'Payroll Access');
  });

  it('handles a failed access-packages fetch without crashing', async () => {
    const authFetch = routes({
      '/api/access-packages': jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
    });
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });

    // On error the list stays empty -> empty state renders (loading clears).
    expect(await screen.findByText('No business roles found.')).toBeInTheDocument();
  });

  it('paginates when there are more results than one page', async () => {
    const authFetch = routes({
      '/api/access-packages': { data: packages, total: 250 },
    });
    renderWithProviders(h(AccessPackagesPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Payroll Access');
    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('offset=100'));
    });
  });
});
