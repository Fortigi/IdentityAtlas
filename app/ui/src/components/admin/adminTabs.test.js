import { describe, it, expect } from 'vitest';
import { ADMIN_TABS, visibleAdminTabs } from './adminTabs.js';

describe('adminTabs', () => {
  it('keeps the Authentication tab, gated on admin.auth', () => {
    const auth = ADMIN_TABS.find(t => t.key === 'auth');
    expect(auth).toBeTruthy();
    expect(auth.requires).toEqual(['admin.auth']);
  });

  it('surfaces Roles & Permissions as its own admin.auth-gated tab (#786)', () => {
    const roles = ADMIN_TABS.find(t => t.key === 'roles');
    expect(roles).toBeTruthy();
    expect(roles.label).toBe('Roles & Permissions');
    expect(roles.requires).toEqual(['admin.auth']);
    // Visible to a user with admin.auth on any platform (permission-driven only).
    expect(visibleAdminTabs(new Set(['admin.auth']), false).map(t => t.key)).toContain('roles');
  });

  it('shows the Authentication tab to a user with admin.auth — on any platform', () => {
    // The whole point of the fix: visibility is permission-driven only, never
    // suppressed by the deployment platform.
    const tabs = visibleAdminTabs(new Set(['admin.auth']), false);
    expect(tabs.map(t => t.key)).toContain('auth');
  });

  it('hides the Authentication tab from a user without admin.auth', () => {
    const tabs = visibleAdminTabs(new Set(['admin.crawlers']), false);
    expect(tabs.map(t => t.key)).not.toContain('auth');
  });

  it('a wildcard user sees every tab', () => {
    const tabs = visibleAdminTabs(new Set(), true);
    expect(tabs).toHaveLength(ADMIN_TABS.length);
  });

  it('always shows tabs with no `requires` (Performance, About)', () => {
    const tabs = visibleAdminTabs(new Set(), false);
    expect(tabs.map(t => t.key)).toEqual(expect.arrayContaining(['performance', 'about']));
  });
});
