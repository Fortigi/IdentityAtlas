// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderWithProviders,
  makeAuthFetch,
  screen,
  fireEvent,
  waitFor,
} from '@ui/test-utils/renderWithProviders';
import UsersPage from '@ui/components/UsersPage';

const LIST = '/api/users';
const COLUMNS = '/api/user-columns-page';

beforeEach(() => {
  sessionStorage.clear();
  window.location.hash = '';
});

// Records every list URL so a test can assert what the sub-tab actually asked the API for.
function renderPage(rows, onOpenDetail = () => {}) {
  const listUrls = [];
  const authFetch = makeAuthFetch((url) => {
    const s = String(url);
    if (s.includes(COLUMNS)) return [];
    if (s.includes('/api/tags')) return [];
    if (s.includes(LIST)) { listUrls.push(s); return { data: rows, total: rows.length }; }
    return undefined;
  });
  const r = renderWithProviders(<UsersPage onOpenDetail={onOpenDetail} />, { auth: { authFetch } });
  return { ...r, listUrls };
}

const ada = { id: 'u1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@example.com', department: 'Engineering', jobTitle: 'Analyst' };

describe('UsersPage rows', () => {
  it('renders a principal row and opens the detail with the user entity type', async () => {
    const onOpenDetail = vi.fn();
    renderPage([ada], onOpenDetail);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('Analyst')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Ada Lovelace'));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'u1', 'Ada Lovelace');
  });

  it('marks a soft-deleted principal with the deleted badge', async () => {
    renderPage([{ ...ada, deletedAt: '2026-01-02T03:04:05Z' }]);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    // Matched on the badge's title — "Include deleted" also contains the word.
    expect(screen.getByTitle(/^Deleted /)).toHaveTextContent('Deleted');
  });
});

describe('UsersPage principalType sub-tabs', () => {
  it('filters the list by the selected type and records it in the URL hash', async () => {
    const { listUrls } = renderPage([ada]);
    await screen.findByText('Ada Lovelace');

    fireEvent.click(screen.getByRole('button', { name: 'Service Principals' }));

    // baseFilters reaches the API…
    await waitFor(() => expect(listUrls.some(u => u.includes('ServicePrincipal'))).toBe(true));
    // …and the tab is deep-linkable.
    expect(window.location.hash).toContain('type=ServicePrincipal');
  });

  it('restores the active tab from the URL hash on mount', async () => {
    window.location.hash = '#users?type=AIAgent';
    const { listUrls } = renderPage([ada]);

    await screen.findByText('Ada Lovelace');
    await waitFor(() => expect(listUrls.some(u => u.includes('AIAgent'))).toBe(true));
  });

  it('ignores an unknown type in the hash and falls back to All', async () => {
    window.location.hash = '#users?type=NotAType';
    const { listUrls } = renderPage([ada]);

    await screen.findByText('Ada Lovelace');
    // 'all' means no principalType filter at all, and the bad value is dropped from the hash.
    expect(listUrls.every(u => !u.includes('NotAType'))).toBe(true);
    expect(window.location.hash).not.toContain('type=');
  });

  it('drops the type from the hash again when switching back to All', async () => {
    renderPage([ada]);
    await screen.findByText('Ada Lovelace');

    fireEvent.click(screen.getByRole('button', { name: 'Managed Identities' }));
    await waitFor(() => expect(window.location.hash).toContain('type=ManagedIdentity'));

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(window.location.hash).not.toContain('type='));
  });
});
