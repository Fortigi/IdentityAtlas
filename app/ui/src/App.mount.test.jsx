// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import App from './App.jsx';
import { renderWithProviders, makeAuthFetch, screen, userEvent } from '@ui/test-utils/renderWithProviders';

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

  it('closing the active tab navigates back when its hash has a UUID id', async () => {
    window.location.hash = '#user:11111111-2222-3333-4444-555555555555';
    renderWithProviders(h(App), prefsAuth);
    const user = userEvent.setup();
    await user.click(await screen.findByTitle('Close'));
    // A tab opened straight from a URL carries no returnPage, so closing it
    // falls back to closeFallbackPage('user') === 'matrix'. The control case
    // for the percent-encoding bug below: a UUID id needs no encoding.
    expect(window.location.hash).toBe('#matrix');
  });

  it('closing the active tab navigates away even when the hash is percent-encoded (#1601)', async () => {
    // What a browser stores after the user types "#department:Human Resources" —
    // location.hash keeps the space percent-encoded (same convention as
    // useHashPage.test.jsx's '#user:a%20b' case).
    window.location.hash = '#department:Human%20Resources';
    renderWithProviders(h(App), prefsAuth);
    const user = userEvent.setup();
    await user.click(await screen.findByTitle('Close'));
    // Closing it must fall back to closeFallbackPage('department') ===
    // 'contexts'. The hash stays '#department:Human%20Resources' while
    // closeDetailTab compares the raw encoded hash with the decoded tab key
    // and so decides the tab being closed is not the one on screen.
    expect(window.location.hash).toBe('#contexts');
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
