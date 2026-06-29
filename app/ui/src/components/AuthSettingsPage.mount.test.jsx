// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import AuthSettingsPage from './AuthSettingsPage';
import { renderWithProviders, makeAuthFetch, screen } from '@ui/test-utils/renderWithProviders';

// AuthSettingsPage loads /api/admin/auth-settings via useFetch and (for admins)
// renders RolesPermissionsSection, which loads /api/admin/roles.
function routes(extra = {}) {
  return makeAuthFetch((url) => {
    const u = String(url);
    if (u.includes('/api/admin/auth-settings')) return { enabled: true, tenantId: 'tid-123', clientId: 'cid-456', requiredRoles: ['Admin'], ...extra };
    if (u.includes('/api/admin/roles')) return { mapping: {}, groups: [], catalog: [] };
    return {};
  });
}

const admin = (authFetch) => ({ auth: { authFetch, hasWildcard: true, permissions: new Set(['*']) } });

describe('AuthSettingsPage (mounted)', () => {
  it('loads and renders the auth-settings state card (useFetch path)', async () => {
    renderWithProviders(h(AuthSettingsPage), admin(routes()));
    expect(await screen.findByText('Authentication')).toBeInTheDocument();
    expect(await screen.findByText('ENABLED')).toBeInTheDocument();
    expect(screen.getByText('tid-123')).toBeInTheDocument();
  });

  it('shows DISABLED when auth is off', async () => {
    renderWithProviders(h(AuthSettingsPage), admin(routes({ enabled: false })));
    expect(await screen.findByText('DISABLED')).toBeInTheDocument();
  });
});
