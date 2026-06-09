import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const authSrc = readFileSync(join(here, 'AuthGateProvider.jsx'), 'utf8');
const appSrc  = readFileSync(join(here, '..', 'App.jsx'), 'utf8');

// The double-scrollbar bug: the auth-disabled banner sat above the app's own
// min-h-screen div. Banner + app together exceeded 100vh, giving the page a
// persistent second (browser-level) scrollbar next to the matrix grid's own
// scrollbar.
describe('double-scrollbar regression guard', () => {
  describe('AuthGateProvider', () => {
    it('wraps banner + children in a single min-h-screen flex column', () => {
      expect(authSrc).toContain('flex flex-col min-h-screen');
    });

    it('banner is flex-none (inside the flex flow, not above it)', () => {
      expect(authSrc).toContain('flex-none');
    });

    it('banner is NOT sticky-positioned above the viewport-height column', () => {
      expect(authSrc).not.toContain('sticky top-0');
    });

    it('children wrapper uses flex-1 min-h-0 so it fills remaining height without overflowing', () => {
      expect(authSrc).toContain('flex-1 min-h-0 flex flex-col');
    });
  });

  describe('App root div', () => {
    it('uses flex-1 min-h-0 (defers to parent height) instead of a second min-h-screen', () => {
      // The App root must be a flex child, not an independent viewport-height anchor.
      // A bare "min-h-screen" on this div re-introduces the double-scroll bug.
      expect(appSrc).toContain('flex-1 min-h-0 flex flex-col bg-gray-50');
    });
  });
});
