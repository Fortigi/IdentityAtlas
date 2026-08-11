// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderWithProviders,
  makeAuthFetch,
  screen,
  fireEvent,
} from '@ui/test-utils/renderWithProviders';
import IdentitiesPage from '@ui/components/IdentitiesPage';

const LIST = '/api/identities';
const COLUMNS = '/api/identity-columns';

beforeEach(() => sessionStorage.clear());

function renderPage(rows, onOpenDetail = () => {}) {
  const authFetch = makeAuthFetch((url) => {
    const s = String(url);
    if (s.includes(COLUMNS)) return [];
    if (s.includes('/api/tags')) return [];
    if (s.includes(LIST)) return { data: rows, total: rows.length };
    return undefined;
  });
  return renderWithProviders(<IdentitiesPage onOpenDetail={onOpenDetail} />, { auth: { authFetch } });
}

describe('IdentitiesPage', () => {
  it('renders an identity row and opens the detail with the identity entity type', async () => {
    const onOpenDetail = vi.fn();
    renderPage([{
      id: 'i1', displayName: 'Ada Lovelace', primaryAccountUpn: 'ada@example.com',
      accountCount: 3, department: 'Engineering', jobTitle: 'Analyst',
    }], onOpenDetail);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    // renderDataCells — the four columns this page adds.
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('Analyst')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Ada Lovelace'));
    expect(onOpenDetail).toHaveBeenCalledWith('identity', 'i1', 'Ada Lovelace');
  });

  it('renders an identity with no account data without printing null or undefined', async () => {
    // accountCount uses `?? ''` while the rest use `|| ''` — a 0 count must still show as 0.
    renderPage([{ id: 'i2', displayName: 'Sparse Person', accountCount: 0 }]);

    const row = (await screen.findByText('Sparse Person')).closest('tr');
    expect(row).toHaveTextContent('0');
    expect(row?.textContent).not.toMatch(/null|undefined/);
  });
});
