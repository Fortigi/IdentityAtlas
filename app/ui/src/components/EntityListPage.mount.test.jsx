// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
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

  it('renders tag pills with a contrast-safe colour, not the old alpha hack (#759)', async () => {
    const af = makeAuthFetch((url) => {
      const s = String(url);
      if (s.includes(COLUMNS)) return [];
      if (s.includes('/api/tags')) return [{ id: 't1', name: 'Prod', color: '#1d4ed8', assignmentCount: 3 }];
      if (s.includes(LIST)) return { data: [{ id: '1', displayName: 'Bob' }], total: 1 };
      return undefined;
    });

    renderPage(af);

    const pill = await screen.findByTitle(/tagged — click to filter/i);
    const style = pill.getAttribute('style') || '';
    expect(style).toMatch(/background-color/);
    // The retired hack rendered `background-color: #1d4ed820` (8-digit alpha hex);
    // tagPillStyle emits a solid tint + an AA-safe text colour instead.
    expect(style).not.toContain('#1d4ed820');
  });

  it('renders a row whose entity carries tags without crashing (#762)', async () => {
    // Regression guard: the extracted EntityListTable renders per-row tag pills via
    // tagPillStyle(t.color, isDark). isDark was declared only in the parent and was
    // not threaded into the child, so rendering any *tagged row* threw
    // `ReferenceError: isDark is not defined`. The other tests never tripped it
    // because their list items had no `tags`; this one gives the item a tag.
    const af = makeAuthFetch((url) => {
      const s = String(url);
      if (s.includes(COLUMNS)) return [];
      if (s.includes('/api/tags')) return [];
      if (s.includes(LIST)) {
        return {
          data: [{ id: '1', displayName: 'Bob', tags: [{ id: 'r1', name: 'Prod', color: '#1d4ed8' }] }],
          total: 1,
        };
      }
      return undefined;
    });

    renderPage(af);

    // The row renders (pre-fix this threw during render and hit the error boundary).
    expect(await screen.findByText('Bob')).toBeInTheDocument();
    // The per-row tag pill is styled via tagPillStyle — solid tint, not the alpha hack.
    const rowPill = screen.getByText('Prod');
    const style = rowPill.getAttribute('style') || '';
    expect(style).toMatch(/background-color/);
    expect(style).not.toContain('#1d4ed820');
  });
});

describe('EntityListPage table wrapper (#758)', () => {
  it('wraps the table in a horizontally-scrolling container, not overflow-hidden', async () => {
    const af = makeAuthFetch((url) => {
      const s = String(url);
      if (s.includes(COLUMNS)) return [];
      if (s.includes('/api/tags')) return [];
      if (s.includes(LIST)) return { data: [{ id: '1', displayName: 'Bob' }], total: 1 };
      return undefined;
    });

    const { container } = renderPage(af);
    await screen.findByText('Bob');

    const wrapper = container.querySelector('table').closest('.overflow-x-auto');
    expect(wrapper).toBeTruthy();
    expect(wrapper.className).not.toMatch(/overflow-hidden/);
  });
});

describe('EntityListPage error state (audit H6)', () => {
  it('shows a distinct error panel (not the empty state) when the list fetch fails, and recovers on Retry', async () => {
    let listCalls = 0;
    const af = makeAuthFetch((url) => {
      const s = String(url);
      if (s.includes(COLUMNS)) return [];
      if (s.includes('/api/tags')) return [];
      if (s.includes(LIST)) {
        listCalls += 1;
        // Fail the first load (HTTP 500), succeed on the retry.
        return listCalls === 1
          ? jsonResponse({ error: 'boom' }, { ok: false, status: 500 })
          : { data: [{ id: '1', displayName: 'Bob' }], total: 1 };
      }
      return undefined;
    });

    renderPage(af);

    // A failed load surfaces a distinct error panel — NOT the empty state it
    // used to be indistinguishable from.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn.t load users/i);
    expect(screen.queryByText(/No users (yet|match)/i)).not.toBeInTheDocument();

    // Retry re-fetches; the second response succeeds and the row renders.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('EntityListPage empty state (audit H-12 / #760)', () => {
  const emptyRoutes = () => makeAuthFetch((url) => {
    const s = String(url);
    if (s.includes(COLUMNS)) return [];
    if (s.includes('/api/tags')) return [];
    if (s.includes(LIST)) return { data: [], total: 0 };
    return undefined;
  });

  it('shows an onboarding EmptyState whose next action navigates to Admin → Crawlers', async () => {
    window.location.hash = '';
    renderPage(emptyRoutes());
    // The shared EmptyState (not a bare "No users found." dead-end) with a real action.
    expect(await screen.findByText('No users yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add a crawler/i }));
    expect(window.location.hash).toContain('admin?sub=crawlers');
  });

  it('switches to a filter-aware EmptyState with "Clear filters" when a search matches nothing', async () => {
    renderPage(emptyRoutes());
    await screen.findByText('No users yet');

    // Typing a search flips hasAnyFilter → the message and action change.
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'zzz' } });
    expect(await screen.findByText('No users match your filters')).toBeInTheDocument();

    // Clearing filters returns to the unfiltered onboarding state.
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('No users yet')).toBeInTheDocument();
  });
});
