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
    expect(screen.getByRole('checkbox', { name: 'Active' })).toBeChecked();
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

  // ── The name-only policy control ──────────────────────────────────────────
  //
  // The checkbox is the documented way to the stricter policy, and it is ON by default, so
  // what it PUTs matters in both directions: a control that renders but never makes it into
  // the saved rules leaves the tenant with no way to tighten linking, and a box that
  // defaults to off would silently tighten it for everybody.

  it('shows the name-only checkbox checked for a config that never stored the key', async () => {
    // The API merges DEFAULT_RULES, where the key is true — and an absent key must read
    // the same way, or an upgrade would present the strict policy as the current one.
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch: routes() } });
    await screen.findByText('Account Linking');

    expect(screen.getByRole('checkbox', { name: /Link on a name match alone/i })).toBeChecked();
  });

  it('says that deleting a signal does not disable it — weight 0 does (#1469)', async () => {
    // The editor shows the EFFECTIVE dictionary: an upgrade merges newly shipped
    // signals back into the saved one by name, so a signal an administrator
    // deleted reappears. Without this said plainly, the only reading of that is
    // "my edit was discarded", and the real off-switch is undiscoverable —
    // nothing else on the page mentions weight 0.
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch: routes() } });
    await screen.findByText('Account Linking');

    const editor = screen.getByText(/Deleting a signal here does not disable it/i).closest('p');
    expect(editor).toHaveTextContent(/effective/i);
    expect(editor).toHaveTextContent(/set its weight to 0/i);
  });

  it('reflects an existing opt-out from the loaded config', async () => {
    const authFetch = routes({
      '/api/account-linking/config': { ...config, rules: { ...config.rules, allowNameOnlyLinks: false } },
    });
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });
    await screen.findByText('Account Linking');

    expect(screen.getByRole('checkbox', { name: /Link on a name match alone/i })).not.toBeChecked();
  });

  it('PUTs allowNameOnlyLinks from the checkbox, not from the rules textarea', async () => {
    // The checkbox is authoritative for its key, the way the slider is for linkThreshold.
    // The textarea deliberately carries the OPPOSITE value here: if the save read the
    // JSON instead, the tenant's click would be silently discarded.
    const puts = [];
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (!String(url).includes('/api/account-linking/config')) return { data: [] };
      if ((opts.method || 'GET') !== 'GET') { puts.push(JSON.parse(opts.body)); return jsonResponse({ ok: true }); }
      return { ...config, rules: { ...config.rules, allowNameOnlyLinks: true } };
    });
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });
    const user = userEvent.setup();
    await screen.findByText('Account Linking');

    await user.click(screen.getByRole('checkbox', { name: /Link on a name match alone/i }));
    await user.click(screen.getByText('Save'));
    await screen.findByText('Saved.');

    expect(puts).toHaveLength(1);
    expect(puts[0].rules.allowNameOnlyLinks).toBe(false);
  });

  it('keeps the shipped policy in the PUT when the box is left alone', async () => {
    // The paired case — the default must be saved as an explicit true, not dropped.
    const puts = [];
    const authFetch = makeAuthFetch((url, opts = {}) => {
      if (!String(url).includes('/api/account-linking/config')) return { data: [] };
      if ((opts.method || 'GET') !== 'GET') { puts.push(JSON.parse(opts.body)); return jsonResponse({ ok: true }); }
      return config;
    });
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });
    const user = userEvent.setup();
    await screen.findByText('Account Linking');

    await user.click(screen.getByText('Save'));
    await screen.findByText('Saved.');

    expect(puts[0].rules.allowNameOnlyLinks).toBe(true);
  });

  it('reports what the completed run held back and removed', async () => {
    vi.useFakeTimers();
    try {
      const authFetch = routes({
        '/api/account-linking/runs/': {
          status: 'completed', linksCreated: 5, linksUpdated: 2, orphansRemaining: 3,
          nameOnlyMatches: 3, linksRemoved: 2,
        },
      });
      renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });
      await vi.waitFor(() => expect(screen.getByText('Account Linking')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Run now'));
      await vi.advanceTimersByTimeAsync(1600);

      await vi.waitFor(() => expect(
        screen.getByText(/3 name-only matches held for review, 2 name-only links removed/i),
      ).toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits the name-only clauses for a run that predates the feature', async () => {
    // Nullable columns: "not measured" must not render as "0 held for review", which
    // would read as a positive finding about a run that never looked.
    vi.useFakeTimers();
    try {
      const authFetch = routes({
        '/api/account-linking/runs/': { status: 'completed', linksCreated: 5, linksUpdated: 2, orphansRemaining: 3 },
      });
      renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });
      await vi.waitFor(() => expect(screen.getByText('Account Linking')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Run now'));
      await vi.advanceTimersByTimeAsync(1600);

      await vi.waitFor(() => expect(screen.getByText(/Linking complete/i)).toBeInTheDocument());
      expect(screen.queryByText(/name-only matches held for review/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the held-for-review card from the newest completed run', async () => {
    const authFetch = routes({
      '/api/account-linking/runs': {
        data: [{
          status: 'completed', nameOnlyMatches: 1,
          nameOnlySuggestions: [{
            principalId: 'p1', displayName: 'Doe, John (OGD)', identityId: 'i1', identityName: 'John Doe',
            confidence: 60, signals: ['fullName'], accountType: 'Secondary',
            reason: 'ambiguousName', rivals: [{ identityId: 'i2', identityName: 'Johanna Doe' }], rivalCount: 1,
          }],
        }],
      },
    });
    renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });

    expect(await screen.findByText('Doe, John (OGD)')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /Name-only matches held for review/i })).toBeInTheDocument();
  });

  it('re-reads the held-for-review card when a run finishes', async () => {
    // A finished run is exactly when the answer changes. Without the refresh the card
    // keeps showing the PREVIOUS run's list while the notice reports new numbers.
    vi.useFakeTimers();
    try {
      const runGets = [];
      const authFetch = makeAuthFetch((url, opts = {}) => {
        const u = String(url);
        if (u.includes('/api/account-linking/config')) return config;
        if (u.includes('/api/account-linking/runs/')) {
          return { status: 'completed', linksCreated: 0, linksUpdated: 0, nameOnlyMatches: 1, linksRemoved: 0 };
        }
        if ((opts.method || 'GET') === 'GET') { runGets.push(u); return { data: [] }; }
        return { id: 'run-1' }; // POST /runs
      });
      renderWithProviders(h(AccountLinkingSettings), { auth: { authFetch } });
      await vi.waitFor(() => expect(screen.getByText('Account Linking')).toBeInTheDocument());
      await vi.waitFor(() => expect(runGets.length).toBe(1)); // the card's mount read

      fireEvent.click(screen.getByText('Run now'));
      await vi.advanceTimersByTimeAsync(1600);

      await vi.waitFor(() => expect(runGets.length).toBe(2));
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
