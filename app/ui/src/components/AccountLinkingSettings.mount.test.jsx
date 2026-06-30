// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import AccountLinkingSettings from './AccountLinkingSettings';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, fireEvent, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

const config = {
  isActive: true,
  defaults: true,
  rules: {
    linkThreshold: 70,
    signals: [{ name: 'upn-prefix' }, { name: 'displayName' }],
    accountTypeRules: [{ pattern: 'adm-' }],
  },
};

function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/account-linking/runs/': { status: 'running', step: 'matching', pct: 50 },
    '/api/account-linking/runs': { id: 'run-1' },
    '/api/account-linking/config': config,
    ...overrides,
  });
}

describe('AccountLinkingSettings (mounted)', () => {
  it('loads the config and reflects it in the controls', async () => {
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch: routes() } });

    expect(await screen.findByText('Account Linking')).toBeInTheDocument();
    // 2 signals, 1 account-type rule, threshold 70 from rules.linkThreshold
    expect(screen.getByText('2 signals')).toBeInTheDocument();
    expect(screen.getByText('1 account-type rule')).toBeInTheDocument();
    expect(screen.getByText('threshold 70%')).toBeInTheDocument();
    expect(screen.getByText(/showing shipped defaults/i)).toBeInTheDocument();
    // Active checkbox reflects isActive
    expect(screen.getByRole('checkbox')).toBeChecked();
    // textarea pre-filled with the rules JSON
    expect(screen.getByRole('textbox')).toHaveValue(JSON.stringify(config.rules, null, 2));
  });

  it('shows a load-error message when the config fetch rejects', async () => {
    const authFetch = makeAuthFetch(async () => {
      throw new Error('network down');
    });
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });

    expect(await screen.findByText('Failed to load configuration.')).toBeInTheDocument();
  });

  it('moves the threshold slider and updates the readout', async () => {
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch: routes() } });
    await screen.findByText('Account Linking');

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '90' } });
    expect(screen.getByText('threshold 90%')).toBeInTheDocument();
    expect(screen.getByText('≥ 90%')).toBeInTheDocument();
  });

  it('saves the rules and shows a success notice', async () => {
    const authFetch = makeAuthFetch((url, opts) => {
      if (url.includes('/api/account-linking/config')) {
        return opts?.method === 'PUT' ? jsonResponse({ ok: true }) : config;
      }
      return jsonResponse({ error: 'not stubbed' }, { ok: false, status: 404 });
    });
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Account Linking');
    await user.click(screen.getByText('Save'));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith(
      '/api/account-linking/config',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('re-fetches the config from the server after a successful save', async () => {
    // Pins the converted loader's reuse path: loadConfig() runs again after a PUT.
    let gets = 0;
    const authFetch = makeAuthFetch((url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/account-linking/config')) {
        if ((opts.method || 'GET') === 'GET') { gets += 1; return config; }
        return jsonResponse({ ok: true }); // PUT
      }
      if (u.includes('/api/account-linking/runs')) return { status: 'idle' };
      return jsonResponse({ ok: true });
    });
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });
    const user = userEvent.setup();
    await screen.findByText('Account Linking');
    const afterMount = gets; // one GET from the mount load

    await user.click(screen.getByText('Save'));
    await screen.findByText('Saved.');

    await waitFor(() => expect(gets).toBeGreaterThan(afterMount));
  });

  it('rejects invalid JSON in the rules editor', async () => {
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch: routes() } });
    await screen.findByText('Account Linking');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{ not json' } });
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByText(/Rules is not valid JSON/i)).toBeInTheDocument();
  });

  it('surfaces a save failure from the server', async () => {
    const authFetch = makeAuthFetch((url, opts) => {
      if (url.includes('/api/account-linking/config')) {
        return opts?.method === 'PUT'
          ? jsonResponse({ error: 'conflict' }, { ok: false, status: 409 })
          : config;
      }
      return jsonResponse({ error: 'not stubbed' }, { ok: false, status: 404 });
    });
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Account Linking');
    await user.click(screen.getByText('Save'));

    expect(await screen.findByText(/Save failed: conflict/i)).toBeInTheDocument();
  });

  it('resets the form by reloading the config', async () => {
    const authFetch = routes();
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Account Linking');
    authFetch.mockClear();
    await user.click(screen.getByText('Reset'));
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith('/api/account-linking/config'),
    );
  });

  it('starts a run and polls it to completion', async () => {
    vi.useFakeTimers();
    try {
      const authFetch = routes({
        '/api/account-linking/runs/': { status: 'completed', linksCreated: 5, linksUpdated: 2, orphansRemaining: 3 },
      });
      renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });

      // flush the load effect (uses promises) under fake timers
      await vi.waitFor(() => expect(screen.getByText('Account Linking')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Run now'));
      await vi.waitFor(() =>
        expect(authFetch).toHaveBeenCalledWith('/api/account-linking/runs', expect.objectContaining({ method: 'POST' })),
      );

      // advance past the 1500ms poll interval
      await vi.advanceTimersByTimeAsync(1600);
      await vi.waitFor(() =>
        expect(screen.getByText(/Linking complete/i)).toBeInTheDocument(),
      );
      expect(screen.getByText(/5 linked, 2 updated, 3 orphans remaining/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed run from the poller', async () => {
    vi.useFakeTimers();
    try {
      const authFetch = routes({
        '/api/account-linking/runs/': { status: 'failed', errorMessage: 'kaboom' },
      });
      renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });
      await vi.waitFor(() => expect(screen.getByText('Account Linking')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Run now'));
      await vi.advanceTimersByTimeAsync(1600);
      await vi.waitFor(() =>
        expect(screen.getByText(/Linking failed: kaboom/i)).toBeInTheDocument(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles a failed run start', async () => {
    const authFetch = routes({
      '/api/account-linking/runs': jsonResponse({ error: 'busy' }, { ok: false, status: 503 }),
    });
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Account Linking');
    await user.click(screen.getByText('Run now'));
    expect(await screen.findByText(/Could not start run: busy/i)).toBeInTheDocument();
  });
});
