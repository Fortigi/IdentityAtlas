import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ConfigWizard, { ENTRA_OBJECT_TYPES_FALLBACK } from './ConfigWizard.jsx';

// renderToStaticMarkup executes the render synchronously, so a missing import
// (e.g. the back-references to app/ui/src/components/ScheduleEditor or
// Stepper) throws here instead of only at runtime in the browser.
describe('Entra ID crawler ConfigWizard', () => {
  const render = (props = {}) =>
    renderToStaticMarkup(h(ConfigWizard, {
      onComplete: () => {},
      onCancel: () => {},
      initialConfig: null,
      isEdit: false,
      authFetch: () => new Promise(() => {}),
      ...props,
    }));

  it('renders step 1 (credentials) without throwing', () => {
    const html = render();
    expect(html).toContain('Add Microsoft Graph Crawler');
    expect(html).toContain('Tenant ID');
    expect(html).toContain('Client Secret');
  });

  it('shows "Edit Microsoft Graph Crawler" in edit mode', () => {
    const html = render({ isEdit: true, initialConfig: { id: 1, displayName: 'Existing', tenantId: 't', clientId: 'c' } });
    expect(html).toContain('Edit Microsoft Graph Crawler');
    expect(html).toContain('leave blank to keep');
  });

  // The fallback catalog is what makes step 2 usable in edit mode (where the
  // live validate response — the authoritative catalog — isn't available). It
  // must stay in sync with ENTRA_OBJECT_TYPES in discover.js, and must include
  // directoryRoles so an existing crawler can be edited to add directory roles.
  it('fallback object-type catalog includes directoryRoles and the full key set', () => {
    const keys = ENTRA_OBJECT_TYPES_FALLBACK.map(o => o.key);
    expect(keys).toContain('directoryRoles');
    expect(keys).toEqual([
      'identity', 'usersGroupsMembers', 'servicePrincipals', 'identityGovernance',
      'appsAppRoles', 'appOwners', 'appPermissions', 'principalRelationships',
      'directoryRoles', 'pim', 'signInLogs', 'oauth2Grants',
    ]);
    // Every entry needs key + label + description for the step-2 checkbox row.
    for (const o of ENTRA_OBJECT_TYPES_FALLBACK) {
      expect(o.key && o.label && o.description, `entry ${o.key} missing a field`).toBeTruthy();
    }
  });
});
