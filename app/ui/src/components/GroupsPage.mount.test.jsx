// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderWithProviders,
  makeAuthFetch,
  screen,
  fireEvent,
} from '@ui/test-utils/renderWithProviders';
import ResourcesPage from '@ui/components/GroupsPage';

// This page is almost entirely a call to EntityListPage plus two render props. Those render props
// are ordinary instrumented function bodies — they simply never ran, because nothing mounted the
// page. Rendering it with one row executes both.
const LIST = '/api/resources';
const COLUMNS = '/api/resource-columns';

beforeEach(() => sessionStorage.clear());   // useEntityPage persists filters per entityType

function renderPage(rows, onOpenDetail = () => {}) {
  const authFetch = makeAuthFetch((url) => {
    const s = String(url);
    if (s.includes(COLUMNS)) return [];
    if (s.includes('/api/tags')) return [];
    if (s.includes(LIST)) return { data: rows, total: rows.length };
    return undefined;
  });
  return renderWithProviders(<ResourcesPage onOpenDetail={onOpenDetail} />, { auth: { authFetch } });
}

describe('ResourcesPage (GroupsPage)', () => {
  it('renders a resource row and opens the detail with the resource entity type', async () => {
    const onOpenDetail = vi.fn();
    renderPage([{ id: 'g1', displayName: 'Finance Admins', resourceType: 'Group', description: 'Owns the ledger' }], onOpenDetail);

    expect(await screen.findByText('Finance Admins')).toBeInTheDocument();
    // renderDataCells: type and description columns.
    expect(screen.getByText('Group')).toBeInTheDocument();
    expect(screen.getByText('Owns the ledger')).toBeInTheDocument();

    // renderEntityCell's onClick — the page's whole job is routing to the right entity kind.
    fireEvent.click(screen.getByText('Finance Admins'));
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'g1', 'Finance Admins');
  });

  it('falls back to groupTypeCalculated when resourceType is absent', async () => {
    renderPage([{ id: 'g2', displayName: 'Legacy Group', groupTypeCalculated: 'Security' }]);

    expect(await screen.findByText('Legacy Group')).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
  });

  it('marks a soft-deleted resource with the deleted badge', async () => {
    renderPage([{ id: 'g3', displayName: 'Retired Group', deletedAt: '2026-01-02T03:04:05Z' }]);

    expect(await screen.findByText('Retired Group')).toBeInTheDocument();
    // The badge carries the deletion time in its title — match on that rather than the word
    // "deleted", which the "Include deleted" filter control also uses.
    expect(screen.getByTitle(/^Deleted /)).toHaveTextContent('Deleted');
  });
});
