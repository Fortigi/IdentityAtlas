// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import App from './App.jsx';
import { renderWithProviders, makeAuthFetch, screen } from '@ui/test-utils/renderWithProviders';

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

describe('App — hash routing', () => {
  it('renders the Principals page for the #principals hash', async () => {
    window.location.hash = '#principals';
    renderWithProviders(h(App), {
      auth: { authFetch: makeAuthFetch({ '/api/preferences': { visibleTabs: [] } }) },
    });
    // UsersPage is lazy-loaded under the #principals route; assert on its
    // principal-type sub-tab bar ("Service Principals" is unique to that page).
    expect((await screen.findAllByText('Service Principals')).length).toBeGreaterThan(0);
  });
});
