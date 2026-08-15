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
});
