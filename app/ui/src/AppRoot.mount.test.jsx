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
