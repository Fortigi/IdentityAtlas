// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderWithProviders,
  makeAuthFetch,
  screen,
  waitFor,
  fireEvent,
} from '@ui/test-utils/renderWithProviders';
import EntityListPage from '@ui/components/EntityListPage';

const LIST = '/api/users';
const COLUMNS = '/api/users/columns';

// useEntityPage persists filters/sort to sessionStorage — isolate each test.
beforeEach(() => sessionStorage.clear());

function renderPage(authFetch) {
  return renderWithProviders(
    <EntityListPage
      title="Users"
      entityType="user"
      listEndpoint={LIST}
      columnsEndpoint={COLUMNS}
      tagFilterKey="__userTag"
      tableColumns={[{ key: 'displayName', label: 'Name' }]}
      fieldLabels={{}}
      renderEntityCell={(item) => <td>{item.displayName}</td>}
      renderDataCells={() => <td />}
      searchPlaceholder="Search"
      onOpenDetail={() => {}}
    />,
    { auth: { authFetch } }
  );
}

describe('EntityListPage pagination', () => {
  it('clicking Next does not crash when the endpoint omits total on later pages', async () => {
    // Mirrors the real list endpoints: total is returned only on page 1 (offset 0);
    // later pages send total:null to skip a redundant COUNT. Regression guard for
    // the `null.toLocaleString()` crash that broke the Next button.
    const af = makeAuthFetch((url) => {
      const s = String(url);
      if (s.includes(COLUMNS)) return [];
      if (s.includes('/api/tags')) return [];
      if (s.includes(LIST)) {
        const offset = new URLSearchParams(s.split('?')[1] || '').get('offset');
        return offset === '0'
          ? { data: [{ id: '1', displayName: 'Bob' }], total: 250 }
          : { data: [{ id: '2', displayName: 'Al' }], total: null };
      }
      return undefined;
    });

    renderPage(af);

    // Page 1 renders with the total and pager.
    expect(await screen.findByText('250 total')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    // The search box carries an accessible name (aria-label) — #761.
    expect(screen.getByRole('textbox', { name: 'Search' })).toBeInTheDocument();

    // Click Next → offset=100 → response has total:null. Pre-fix this threw.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(screen.getByText('Page 2 of 3')).toBeInTheDocument());
    // Total is preserved (still a number), header + pager still render.
    expect(screen.getByText('250 total')).toBeInTheDocument();
    expect(screen.getByText('Al')).toBeInTheDocument();
  });
});
