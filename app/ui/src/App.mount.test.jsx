// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import App from './App.jsx';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor, within, fireEvent,
} from '@ui/test-utils/renderWithProviders';
import { makeWizardFetch, gotoStep } from '@ui/test-utils/matrixWizardFixtures';

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

// The optional tabs a user switches on or off in the settings menu. The choice
// is theirs, so it is saved with their preferences.
describe('App — the optional tabs a user chooses to see', () => {
  const navTab = (name) => screen.queryByRole('button', { name });
  const savedTabs = (authFetch) => authFetch.mock.calls
    .filter(([url, opts]) => String(url).includes('/api/preferences') && opts?.method === 'PUT')
    .map(([, opts]) => JSON.parse(opts.body).visibleTabs);

  it('shows the saved tabs, and saves each switch flipped in the settings menu', async () => {
    window.location.hash = '#principals';
    const authFetch = makeAuthFetch({ '/api/preferences': { visibleTabs: ['systems'] } });
    renderWithProviders(h(App), { auth: { authFetch } });
    const user = userEvent.setup();

    // Until the preferences arrive nothing is hidden, so wait for Contexts to go.
    await waitFor(() => expect(navTab('Contexts')).not.toBeInTheDocument());
    expect(navTab('Systems')).toBeInTheDocument();

    await user.click(screen.getByTitle('Settings'));
    expect(screen.getByRole('switch', { name: 'Show Systems tab' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Show Contexts tab' })).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('switch', { name: 'Show Contexts tab' }));
    expect(navTab('Contexts')).toBeInTheDocument();
    expect(navTab('Systems')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Show Systems tab' }));
    expect(navTab('Systems')).not.toBeInTheDocument();
    expect(navTab('Contexts')).toBeInTheDocument();

    expect(savedTabs(authFetch)).toEqual([['systems', 'contexts'], ['contexts']]);
  });

  it('hides the optional tabs when the preferences cannot be loaded', async () => {
    window.location.hash = '#principals';
    const authFetch = makeAuthFetch(async (url) => {
      if (String(url).includes('/api/preferences')) throw new Error('offline');
      return undefined;
    });
    renderWithProviders(h(App), { auth: { authFetch } });

    // While loading the optional tabs are shown; a failed load must settle on
    // "none chosen" instead of leaving the app in that loading state.
    await waitFor(() => expect(navTab('Systems')).not.toBeInTheDocument());
    expect(navTab('Contexts')).not.toBeInTheDocument();
    expect(navTab('Matrix')).toBeInTheDocument();
  });
});

describe('App — closing the settings menu', () => {
  const openMenu = async (auth = {}) => {
    window.location.hash = '#principals';
    renderWithProviders(h(App), { auth: { ...prefsAuth.auth, ...auth } });
    const user = userEvent.setup();
    await user.click(await screen.findByTitle('Settings'));
    expect(await screen.findByText('Theme')).toBeInTheDocument();
    return user;
  };

  it('stays open for a click inside it and closes for a click outside it', async () => {
    await openMenu();
    fireEvent.mouseDown(screen.getByText('Visible Tabs'));
    expect(screen.getByText('Theme')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Theme')).not.toBeInTheDocument();
  });

  it('closes and signs the user out on Sign out', async () => {
    const logout = vi.fn();
    const user = await openMenu({ logout });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Theme')).not.toBeInTheDocument();
  });
});

describe('App — the matrix cannot be loaded', () => {
  it('replaces the app with the backend error and the reason the server gave', async () => {
    const filter = { rowType: 'resource' };
    window.location.hash = `#matrix?filter=${encodeURIComponent(JSON.stringify(filter))}`;
    const authFetch = makeAuthFetch({
      '/api/preferences': { visibleTabs: [] },
      '/api/matrix/data': jsonResponse({ error: 'database unavailable' }, { ok: false, status: 503 }),
    });
    renderWithProviders(h(App), { auth: { authFetch } });

    expect(await screen.findByRole('heading', { name: 'Backend not responding' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('database unavailable')).toBeInTheDocument();
    expect(screen.queryByTitle('Settings')).not.toBeInTheDocument();
  });
});

describe('App — the matrix wizard', () => {
  // The app's own endpoints, with everything the wizard asks for behind them.
  const wizardAuth = () => {
    const wizard = makeWizardFetch();
    const routes = {
      '/api/preferences': { visibleTabs: [] },
      '/api/admin/dashboard-stats': { hasData: true },
      '/api/matrix/default-filter': null,
      '/api/matrix/data': { data: [], rowType: 'principal' },
    };
    const authFetch = makeAuthFetch(async (url, opts) => {
      const key = Object.keys(routes).find((k) => String(url).includes(k));
      return key ? jsonResponse(routes[key]) : wizard(url, opts);
    });
    return { auth: { authFetch } };
  };

  const openNewMatrix = async () => {
    window.location.hash = '#matrix';
    renderWithProviders(h(App), wizardAuth());
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New matrix' }));
    expect(await screen.findByText('Create matrix')).toBeInTheDocument();
    return user;
  };

  it('closes on Cancel and leaves the list of matrices as it was', async () => {
    const user = await openNewMatrix();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Create matrix')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Open a matrix' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#matrix');
  });

  it('applies the matrix and the lens chosen in it, and closes', async () => {
    const user = await openNewMatrix();
    await gotoStep(user, 'Layout');
    const lens = screen.getByRole('group', { name: 'Default lens' });
    await user.click(within(lens).getByRole('button', { name: 'Gaps' }));
    await gotoStep(user, 'Save & share');
    await user.click(await screen.findByRole('button', { name: 'Show matrix' }));

    expect(screen.queryByText('Create matrix')).not.toBeInTheDocument();
    // The applied matrix is the one on screen now: it is what the URL carries.
    await waitFor(() => expect(window.location.hash).toContain('managed=gaps'));
    expect(window.location.hash).toContain('filter=');
    expect(screen.queryByRole('heading', { name: 'Open a matrix' })).not.toBeInTheDocument();
  });
});
