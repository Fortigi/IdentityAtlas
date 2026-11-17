import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import SignInMethodFields from './SignInMethodFields.jsx';
import Summary from './Summary.jsx';

const render = (props) => renderToStaticMarkup(h(SignInMethodFields, { onChange: () => {}, ...props }));
const AVAILABLE = { available: true, clientId: 'aaaa-bbbb' };

describe('SignInMethodFields', () => {
  it('renders nothing in a deployment without a crawler identity', () => {
    expect(render({ authMethod: 'ClientSecret', managedIdentity: { available: false, clientId: null } })).toBe('');
    expect(render({ authMethod: 'ClientSecret', managedIdentity: null })).toBe('');
  });

  it('offers both methods, with App registration selected, when an identity is available', () => {
    const html = render({ authMethod: 'ClientSecret', managedIdentity: AVAILABLE });
    expect(html).toContain('Sign-in method');
    expect(html).toContain('App registration');
    expect(html).toContain('Managed identity');
    // Exactly one radio checked, and it is the first (App registration).
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html.indexOf('checked=""')).toBeLessThan(html.indexOf('App registration'));
    // The managed-identity explanation only appears once that method is chosen.
    expect(html).not.toContain('aaaa-bbbb');
  });

  it('names the identity it will sign in as once Managed identity is chosen', () => {
    const html = render({ authMethod: 'ManagedIdentity', managedIdentity: AVAILABLE });
    expect(html).toContain('aaaa-bbbb');
    expect(html).toContain('reads the tenant the deployment runs in');
    expect(html.indexOf('checked=""')).toBeGreaterThan(html.indexOf('App registration'));
    expect(html).not.toContain('cannot sign in');
  });

  it('says so when a managed-identity crawler is opened in a deployment that has no identity', () => {
    const html = render({ authMethod: 'ManagedIdentity', managedIdentity: { available: false, clientId: null } });
    expect(html).toContain('cannot sign in');
    expect(html).not.toContain('signs in as the managed identity');
  });
});

describe('Entra ID crawler Summary — sign-in', () => {
  const summary = (cfg) => renderToStaticMarkup(h(Summary, { cfg }));

  it('shows the client ID and a masked secret for an app registration', () => {
    const html = summary({ tenantId: 't-1', clientId: 'c-1' });
    expect(html).toContain('Client ID:');
    expect(html).toContain('c-1');
    expect(html).toContain('Secret:');
    expect(html).not.toContain('Managed identity');
  });

  it('shows the managed identity instead — no client ID, no secret row', () => {
    // clientId is still in the stored config of a crawler switched over from an app registration.
    const html = summary({ authMethod: 'ManagedIdentity', tenantId: 't-1', clientId: 'old-client' });
    expect(html).toContain('Managed identity');
    expect(html).toContain('t-1');
    expect(html).not.toContain('old-client');
    expect(html).not.toContain('Secret:');
  });
});
