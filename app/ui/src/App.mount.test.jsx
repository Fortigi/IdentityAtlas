// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import App from './App.jsx';
import { renderWithProviders, makeAuthFetch, screen, userEvent, waitFor } from '@ui/test-utils/renderWithProviders';

// App reads the global `fetch` for /api/version + /api/features (both swallowed
// on error) and, via useTheme, localStorage. jsdom here provides neither, so
// stub both — otherwise mounting throws before routing runs.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })));
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  });
  window.location.hash = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const prefsAuth = { auth: { authFetch: makeAuthFetch({ '/api/preferences': { visibleTabs: [] } }) } };

describe('App — hash routing', () => {
  it('renders the Principals page for the #principals hash', async () => {
    window.location.hash = '#principals';
    renderWithProviders(h(App), prefsAuth);
    // UsersPage is lazy-loaded under the #principals route; assert on its
    // principal-type sub-tab bar ("Service Principals" is unique to that page).
    expect((await screen.findAllByText('Service Principals')).length).toBeGreaterThan(0);
  });

  it('opens the settings menu with its theme selector', async () => {
    window.location.hash = '#principals';
    renderWithProviders(h(App), prefsAuth);
    const user = userEvent.setup();
    await user.click(await screen.findByTitle('Settings'));
    // ThemeSelector renders its label and one labelled button per mode.
    expect(await screen.findByText('Theme')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dark' })).toBeInTheDocument();
  });

  it('renders a detail tab + detail page for a #user: hash', async () => {
    window.location.hash = '#user:u-123';
    renderWithProviders(h(App), prefsAuth);
    // DetailTab renders the id placeholder label plus a hover Close control.
    expect(await screen.findByTitle('Close')).toBeInTheDocument();
    expect(screen.getAllByText('u-123').length).toBeGreaterThan(0);
  });
});

// #1202: arriving on the matrix tab with data but no org default no longer
// throws the wizard open — it shows the saved matrices to open, and New matrix.
describe('App — the matrix tab with no matrix on screen', () => {
  const matrixAuth = (defaultFilter) => ({
    auth: {
      authFetch: makeAuthFetch({
        '/api/preferences': { visibleTabs: [] },
        '/api/admin/dashboard-stats': { hasData: true },
        '/api/matrix/default-filter': defaultFilter,
        '/api/matrix/saved-filters': [{ id: 'sf-1', name: 'HR users', filter: { rowType: 'principal' } }],
        '/api/matrix/columns': [],
        '/api/matrix/preview': { subjectCount: 0, subjectTotal: 0, resourceCount: 0, resourceTotal: 0, assignmentCount: 0 },
      }),
    },
  });

  it('shows "Open a matrix" instead of opening the wizard, and New matrix opens a fresh one', async () => {
    window.location.hash = '#matrix';
    renderWithProviders(h(App), matrixAuth(null));

    expect(await screen.findByRole('button', { name: /HR users/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Open a matrix' })).toBeInTheDocument();
    // The wizard's title for a new matrix — absent until asked for.
    expect(screen.queryByText('Create matrix')).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'New matrix' }));
    expect(await screen.findByText('Create matrix')).toBeInTheDocument();
  });
});

// The matrix keeps its filter in the URL, so a matrix can be bookmarked and
// shared as a link. Both directions are covered here: what App writes to the
// hash, and what it reads back from one.
describe('App — the matrix filter in the URL', () => {
  const DEFAULT_ID = 'df-1';
  const orgDefault = (filter) => ({ id: DEFAULT_ID, name: 'Org default', filter });

  const matrixAuth = (defaultFilter) => {
    const authFetch = makeAuthFetch({
      '/api/preferences': { visibleTabs: [] },
      '/api/admin/dashboard-stats': { hasData: true },
      '/api/matrix/default-filter': defaultFilter,
      '/api/matrix/saved-filters': [{ id: 'sf-1', name: 'HR users', filter: { rowType: 'principal' } }],
      '/api/matrix/columns': [],
      '/api/matrix/data': { data: [], rowType: 'principal' },
    });
    return { authFetch, options: { auth: { authFetch } } };
  };

  // The hash as App itself would read it back: page, filter object, managed.
  const readHash = () => {
    const [page, query = ''] = window.location.hash.replace('#', '').split('?');
    const params = new URLSearchParams(query);
    return {
      page,
      filter: params.has('filter') ? JSON.parse(params.get('filter')) : null,
      managed: params.get('managed'),
    };
  };

  // The filters the matrix was actually loaded with, in order.
  const loadedFilters = (authFetch) => authFetch.mock.calls
    .filter(([url]) => String(url).includes('/api/matrix/data'))
    .map(([, opts]) => JSON.parse(opts.body).filter);

  it('writes the applied default filter and its managed lens to the hash', async () => {
    window.location.hash = '#matrix';
    const { options } = matrixAuth(orgDefault({ rowType: 'resource', managed: 'gaps' }));
    renderWithProviders(h(App), options);

    await waitFor(() => expect(readHash()).toEqual({
      page: 'matrix',
      // `managed` travels as its own parameter, not inside the filter; the
      // filter is tagged with the default it came from.
      filter: { rowType: 'resource', savedFilterId: DEFAULT_ID },
      managed: 'gaps',
    }));
  });

  it('leaves the managed lens out of the hash while it is the default "all"', async () => {
    window.location.hash = '#matrix';
    const { options } = matrixAuth(orgDefault({ rowType: 'principal' }));
    renderWithProviders(h(App), options);

    await waitFor(() => expect(readHash().filter).toEqual({ rowType: 'principal', savedFilterId: DEFAULT_ID }));
    expect(window.location.hash).not.toContain('managed');
  });

  it('opens a shared link on the filter in its hash, not on the org default', async () => {
    const shared = { rowType: 'resource', conditions: [{ field: 'department', value: 'Finance' }] };
    window.location.hash = `#matrix?filter=${encodeURIComponent(JSON.stringify(shared))}&managed=unmanaged`;
    const { authFetch, options } = matrixAuth(orgDefault({ rowType: 'principal' }));
    renderWithProviders(h(App), options);

    await waitFor(() => expect(loadedFilters(authFetch)).toEqual([shared]));
    // The link's own state survives the URL sync: same filter, same lens, and
    // no savedFilterId — the default was never applied over it.
    await waitFor(() => expect(window.location.hash).toContain('managed=unmanaged'));
    expect(readHash()).toEqual({ page: 'matrix', filter: shared, managed: 'unmanaged' });
  });

  it('ignores a filter it cannot parse and falls back to the list of matrices', async () => {
    window.location.hash = '#matrix?filter=%7Bnot-json';
    const { authFetch, options } = matrixAuth(null);
    renderWithProviders(h(App), options);

    expect(await screen.findByRole('heading', { name: 'Open a matrix' })).toBeInTheDocument();
    // The broken parameter is dropped from the URL rather than kept around.
    await waitFor(() => expect(window.location.hash).toBe('#matrix'));
    expect(loadedFilters(authFetch)).toEqual([]);
  });

  it('ignores a filter that is valid JSON but not an object', async () => {
    window.location.hash = '#matrix?filter=42';
    const { authFetch, options } = matrixAuth(null);
    renderWithProviders(h(App), options);

    expect(await screen.findByRole('heading', { name: 'Open a matrix' })).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe('#matrix'));
    expect(loadedFilters(authFetch)).toEqual([]);
  });
});
