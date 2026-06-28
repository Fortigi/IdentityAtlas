// Shared mount-test harness for React component tests.
//
// Unlike the older `renderToStaticMarkup` source-inspection tests (which only
// render the initial SSR state and never run effects), this mounts components
// into a real jsdom DOM via @testing-library/react — so useEffect data fetches,
// state transitions, and click handlers actually execute and count toward
// coverage. Test files that use this MUST opt into the DOM environment with a
// docblock on line 1:
//
//   // @vitest-environment jsdom
//
// Reuse this helper for every component mount test — do not re-wire providers
// or fetch mocks per file.

import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement as h } from 'react';
import { ThemeContext } from '@ui/contexts/ThemeContext';
import { AuthContext } from '@ui/auth/AuthGate';

// @testing-library/react does not auto-clean when vitest `globals` is off (this
// project imports test fns explicitly), so unmount between tests ourselves.
afterEach(cleanup);

// jsdom doesn't implement these; components that read them (theme, charts,
// virtualized lists) would otherwise throw on mount.
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
  for (const Obs of ['ResizeObserver', 'IntersectionObserver']) {
    if (!window[Obs]) {
      window[Obs] = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  }
  if (!window.scrollTo) window.scrollTo = () => {};
}

// A fetch-Response-shaped object. authFetch callers read .ok/.status/.json().
export function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// Builds a vi.fn() authFetch from either a function (url, opts) => body|Response
// or an object whose keys are matched as substrings of the request URL. A bare
// body value is wrapped in a 200 JSON response; return jsonResponse(...) to
// control status. Unmatched URLs resolve to 404 so a missing stub is obvious.
export function makeAuthFetch(handler = {}) {
  return vi.fn(async (url, opts = {}) => {
    let result;
    if (typeof handler === 'function') {
      result = await handler(url, opts);
    } else {
      const key = Object.keys(handler).find((k) => String(url).includes(k));
      result = key != null ? handler[key] : undefined;
    }
    if (result === undefined) return jsonResponse({ error: 'not stubbed' }, { ok: false, status: 404 });
    if (result && typeof result.json === 'function') return result; // already a Response
    return jsonResponse(result);
  });
}

const defaultAuth = {
  authFetch: makeAuthFetch({}),
  account: { name: 'Test Analyst', username: 'analyst@example.com' },
  logout: () => {},
  authEnabled: false,
  permissions: null,
  roles: [],
  hasWildcard: true,
  permissionsLoaded: true,
  refreshPermissions: async () => {},
};

// Mounts `ui` wrapped in the Theme + Auth providers most components consume.
// Pass `{ auth: { authFetch } }` to inject a stubbed API, `{ theme }` to flip
// dark mode. Returns the Testing Library result plus the resolved authFetch
// (handy for asserting calls without re-importing it).
export function renderWithProviders(ui, { auth = {}, theme = { isDark: false, mode: 'light' } } = {}) {
  const authValue = { ...defaultAuth, ...auth };
  const result = render(
    h(ThemeContext.Provider, { value: theme }, h(AuthContext.Provider, { value: authValue }, ui)),
  );
  return { authFetch: authValue.authFetch, ...result };
}

// Re-export the Testing Library surface so test files import everything from
// one place.
export { screen, within, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';
