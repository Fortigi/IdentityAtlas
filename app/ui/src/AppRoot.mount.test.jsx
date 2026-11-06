// @vitest-environment jsdom
//
// Mount tests for the root route dispatcher (#1166): a share link must reach
// the bare shared shell, and every other hash must still reach the app.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen, act, cleanup } from '@ui/test-utils/renderWithProviders';

vi.mock('@ui/App', () => ({ default: () => <div data-testid="app-shell">app</div> }));
vi.mock('@ui/components/SharedMatrixPage', () => ({
  default: ({ token }) => <div data-testid="shared-shell">{token}</div>,
}));
vi.mock('@ui/components/ContextOwnerPage', () => ({ default: () => <div data-testid="owner-shell">owner</div> }));

const { default: AppRoot } = await import('./AppRoot');

function setHash(hash) {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

beforeEach(() => { window.location.hash = ''; });
afterEach(() => { cleanup(); window.location.hash = ''; });

describe('AppRoot', () => {
  it('renders the normal app shell for an ordinary hash', () => {
    window.location.hash = '#matrix';
    renderWithProviders(<AppRoot />);
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('shared-shell')).not.toBeInTheDocument();
  });

  it('renders the shared shell (and passes the token) for a #shared: hash', async () => {
    window.location.hash = '#shared:fgs_abc123';
    renderWithProviders(<AppRoot />);
    expect(await screen.findByTestId('shared-shell')).toHaveTextContent('fgs_abc123');
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
  });

  it('switches between the two as the hash changes', async () => {
    renderWithProviders(<AppRoot />);
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();

    await act(async () => setHash('#shared:fgs_xyz'));
    expect(await screen.findByTestId('shared-shell')).toHaveTextContent('fgs_xyz');

    await act(async () => setHash('#dashboard'));
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });

  it('falls back to the app shell for an empty share token', () => {
    window.location.hash = '#shared:';
    renderWithProviders(<AppRoot />);
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });
});

describe('AppRoot — context owners', () => {
  const owner = {
    authEnabled: true, permissionsLoaded: true, hasWildcard: false, permissions: new Set(),
    contextOwner: { contexts: [{ id: 'c1', displayName: 'Finance', role: 'Responsible' }], contextIds: ['c1'] },
  };

  it('routes a permissionless context owner to the owner page, whatever the hash', async () => {
    window.location.hash = '#matrix';
    renderWithProviders(<AppRoot />, { auth: owner });
    expect(await screen.findByTestId('owner-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
  });

  it('sends a context owner to the owner page even from a share link', async () => {
    window.location.hash = '#shared:fgs_abc';
    renderWithProviders(<AppRoot />, { auth: owner });
    expect(await screen.findByTestId('owner-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('shared-shell')).not.toBeInTheDocument();
  });

  it('gives an owner who also holds a permission the normal app', () => {
    renderWithProviders(<AppRoot />, { auth: { ...owner, permissions: new Set(['data.read']) } });
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });

  it('renders neither shell until auth-me has answered on an auth-enabled install', () => {
    renderWithProviders(<AppRoot />, { auth: { ...owner, permissionsLoaded: false } });
    expect(screen.getByText('Signing in...')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    expect(screen.queryByTestId('owner-shell')).not.toBeInTheDocument();
  });

  it('does not wait in open mode', () => {
    renderWithProviders(<AppRoot />, { auth: { authEnabled: false, permissionsLoaded: false } });
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });
});
