// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement as h } from 'react';
import AdminPage from './AdminPage';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  userEvent,
} from '@ui/test-utils/renderWithProviders';

// AdminPage hits a broad set of endpoints across its inline sub-tabs (Data,
// Risk Scoring, LLM Settings) plus the lazy child pages (Crawlers, Plugins,
// Account Linking, Performance, Authentication, About). This single function-
// form authFetch returns a sensible shape for every URL so no tab throws when
// rendered. The lazy children are exercised separately by their own mount
// tests — here we mostly care that AdminPage's own render/switch paths run.
function adminRoutes(url) {
  const u = String(url);

  // ── Data tab ────────────────────────────────────────────────────
  if (u.includes('/api/admin/read-tokens')) {
    return [
      {
        id: 'tok1',
        name: 'PowerBI prod',
        tokenPrefix: 'fgr_abc',
        createdAt: '2026-01-01T00:00:00Z',
        lastUsedAt: '2026-02-01T00:00:00Z',
        revoked: false,
      },
    ];
  }
  if (u.includes('/api/admin/history-retention')) {
    return { retentionDays: 180, totalRows: 12345 };
  }

  // ── LLM Settings tab ────────────────────────────────────────────
  if (u.includes('/api/admin/llm/config')) {
    return {
      providers: ['anthropic', 'openai', 'azure-openai'],
      defaultModels: { anthropic: 'claude-3', openai: 'gpt-4o' },
      apiKeySet: true,
      config: { provider: 'anthropic', model: 'claude-3', endpoint: '', deployment: '', apiVersion: '' },
    };
  }

  // ── Risk Scoring tab (profile + classifiers) ────────────────────
  if (u.includes('/api/admin/risk-profile')) {
    return {
      available: true,
      isActive: true,
      displayName: 'Acme Corp',
      domain: 'acme.com',
      industry: 'Finance',
      country: 'US',
      llmProvider: 'anthropic',
      llmModel: 'claude-3',
      version: 2,
      generatedAt: '2026-03-01T00:00:00Z',
      profile: {
        name: 'Acme Corp',
        description: 'A financial services company.',
        regulations: [{ name: 'SOX', relevance: 'financial controls' }],
        critical_roles: [{ title_patterns: ['Admin'], rationale: 'high privilege' }],
        known_systems: [{ name: 'SAP', criticality: 'critical' }],
        critical_business_processes: ['Payroll'],
        risk_domains: [{ domain: 'Finance', weight: 5 }],
      },
    };
  }
  if (u.includes('/api/admin/classifiers')) {
    return {
      available: true,
      isActive: true,
      displayName: 'Acme Classifiers',
      version: 2,
      llmProvider: 'anthropic',
      llmModel: 'claude-3',
      generatedAt: '2026-03-01T00:00:00Z',
      classifiers: {
        groupClassifiers: [
          { id: 'g1', label: 'Admin Groups', description: 'admin', patterns: ['admin*'], score: 80, tier: 'critical', domain: 'IT' },
        ],
        userClassifiers: [
          { id: 'u1', label: 'Privileged Users', patterns: ['svc*'], score: 50, tier: 'high', domain: 'IT' },
        ],
        agentClassifiers: [],
      },
    };
  }

  // ── Lazy child pages (best-effort stubs so they don't crash) ─────
  if (u.includes('/api/admin/status')) return { running: false };
  if (u.includes('/api/admin/crawler-configs')) return [];
  if (u.includes('/api/admin/crawler-jobs')) return [];
  if (u.includes('/api/account-linking/config')) return { rules: [], enabled: false };
  if (u.includes('/api/account-linking/runs')) return { runs: [] };
  if (u.includes('/api/perf')) return {};
  if (u.includes('/api/admin/auth-settings')) return { authEnabled: false, roles: [], permissions: [] };
  if (u.includes('/api/context-plugins')) return { data: [] };

  // Unknown — empty object keeps json()-then-read paths from throwing.
  return {};
}

beforeEach(() => {
  // Default sub-tab is "crawlers", whose lazy child (CrawlersPage) eagerly
  // pulls every crawler's Summary.jsx via import.meta.glob — those modules
  // fail to transform under the test runner. Land on the Data tab instead so
  // the default render path stays inside AdminPage's own inline sections.
  window.location.hash = '#admin?sub=data';

  // RiskScoringSection uses bare global fetch (not authFetch) for /api/features.
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/api/features')) {
      return jsonResponse({ riskScoring: true });
    }
    return jsonResponse({});
  }));
  // jsdom has no clipboard / URL.createObjectURL by default.
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn() }, configurable: true });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
});

function renderAdmin(routeFn = adminRoutes) {
  return renderWithProviders(h(AdminPage, {}), {
    auth: { authFetch: makeAuthFetch(routeFn), hasWildcard: true, permissions: new Set(['*']) },
  });
}

describe('AdminPage (mounted)', () => {
  it('renders the admin shell with all sub-tabs visible', async () => {
    renderAdmin();
    expect(await screen.findByRole('heading', { name: 'Admin' })).toBeInTheDocument();
    for (const label of ['Crawlers', 'Plugins', 'Account Linking', 'Risk Scoring', 'LLM Settings', 'Performance', 'Authentication', 'Data', 'Updates', 'About']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('renders the Data tab: Power Query tokens, curated data, history retention and danger zone', async () => {
    renderAdmin();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Data' }));

    // Power Query section is a collapsed <Section> — expand it to reveal the
    // token table loaded from /api/admin/read-tokens.
    await user.click(await screen.findByText('Excel Power Query Workbook'));
    expect(await screen.findByText('PowerBI prod')).toBeInTheDocument();
    expect(screen.getByText(/fgr_abc/)).toBeInTheDocument();

    // Curated data + history + danger zone all render in the Data tab
    expect(screen.getByText('Curated Data')).toBeInTheDocument();
    expect(screen.getByText(/History Retention/)).toBeInTheDocument();
    // Locale-agnostic: the component formats via toLocaleString(), so build the
    // expected text the same way (the thousands separator differs per locale —
    // en-US "12,345" vs en-NL "12.345"). Escape it for the regex.
    const rows = (12345).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(await screen.findByText(new RegExp(`${rows} history rows stored`))).toBeInTheDocument();
    expect(screen.getByText('Danger Zone')).toBeInTheDocument();
  });

  it('gates Data-tab sections: an admin.systems-only user sees retention + danger zone, not the export sections', async () => {
    renderWithProviders(h(AdminPage, {}), {
      auth: { authFetch: makeAuthFetch(adminRoutes), hasWildcard: false, permissions: new Set(['admin.systems']) },
    });
    // Lands on the Data tab (hash sub=data from beforeEach; admin.systems keeps it visible).
    expect(await screen.findByText('Danger Zone')).toBeInTheDocument();
    expect(screen.getByText(/History Retention/)).toBeInTheDocument();
    // Export/import sections need data.export.* / admin.csv-import → hidden.
    expect(screen.queryByText('Excel Power Query Workbook')).not.toBeInTheDocument();
    expect(screen.queryByText('Curated Data')).not.toBeInTheDocument();
  });

  it('gates Data-tab sections: a data.export.ui-only user sees the export sections, not the destructive ones', async () => {
    renderWithProviders(h(AdminPage, {}), {
      auth: { authFetch: makeAuthFetch(adminRoutes), hasWildcard: false, permissions: new Set(['data.export.ui']) },
    });
    expect(await screen.findByText('Curated Data')).toBeInTheDocument();
    expect(screen.getByText('Excel Power Query Workbook')).toBeInTheDocument();
    // Retention + clean-database need admin.systems → hidden.
    expect(screen.queryByText('Danger Zone')).not.toBeInTheDocument();
    expect(screen.queryByText(/History Retention/)).not.toBeInTheDocument();
  });

  it('walks the Danger Zone confirmation flow', async () => {
    renderAdmin();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Data' }));

    await screen.findByText('Danger Zone');
    await user.click(screen.getByRole('button', { name: 'Clean Database' }));
    expect(await screen.findByText('Are you sure?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }));
    expect(await screen.findByText('Final confirmation')).toBeInTheDocument();
    // The confirm button stays disabled until the magic phrase is typed.
    await user.type(screen.getByPlaceholderText('DELETE ALL DATA'), 'DELETE ALL DATA');
    expect(screen.getByRole('button', { name: 'Clean Database' })).toBeEnabled();
  });

  it('opens the "Create token only" form in the Data tab', async () => {
    renderAdmin();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Data' }));

    // Expand the collapsed Power Query section first.
    await user.click(await screen.findByText('Excel Power Query Workbook'));
    await user.click(await screen.findByRole('button', { name: /Create token only/ }));
    expect(await screen.findByPlaceholderText(/Token name/)).toBeInTheDocument();
  });

  it('renders the Risk Scoring tab with profile + classifiers after the feature loads', async () => {
    renderAdmin();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Risk Scoring' }));

    expect(await screen.findByText('Risk Scoring Feature')).toBeInTheDocument();
    expect(await screen.findByText('Run risk scoring')).toBeInTheDocument();
    // Risk profile section content (loaded from /api/admin/risk-profile)
    expect(await screen.findByText('Organization Description')).toBeInTheDocument();
    expect(screen.getByText('A financial services company.')).toBeInTheDocument();
    // Classifiers section title
    expect(screen.getByText('Risk Classifiers')).toBeInTheDocument();
  });

  it('expands the Risk Classifiers section and switches its sub-tabs', async () => {
    renderAdmin();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Risk Scoring' }));

    // Classifiers Section is collapsed by default — expand it.
    await user.click(await screen.findByText('Risk Classifiers'));
    expect(await screen.findByText('Admin Groups')).toBeInTheDocument();

    // Switch to the Users classifier sub-tab.
    await user.click(screen.getByRole('button', { name: /Users \(1\)/ }));
    expect(await screen.findByText('Privileged Users')).toBeInTheDocument();
  });

  it('renders the LLM Settings tab form populated from the saved config', async () => {
    renderAdmin();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'LLM Settings' }));

    expect(await screen.findByText('LLM Provider')).toBeInTheDocument();
    // apiKeySet:true → the "• stored" badge shows next to the API key label.
    expect(screen.getByText(/stored/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
    // Provider select reflects the saved provider.
    expect(screen.getByRole('option', { name: 'Anthropic Claude' })).toBeInTheDocument();
  });

  it('switches the LLM provider through the render-time model reset without crashing', async () => {
    renderAdmin();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'LLM Settings' }));
    await screen.findByText('LLM Provider');

    // The provider <select> starts on the saved 'anthropic' value. Switching it
    // drives config.provider through the render-time provider-change handling
    // (which clears any discovered model list).
    const selects = screen.getAllByRole('combobox');
    const providerSelect = selects.find((s) => s.value === 'anthropic') || selects[0];
    await user.selectOptions(providerSelect, 'azure-openai');

    expect(providerSelect.value).toBe('azure-openai');
    // Card still renders — the provider-change reset ran during render.
    expect(screen.getByText('LLM Provider')).toBeInTheDocument();
  });

  it('runs an LLM connection test and surfaces the result', async () => {
    const authFetch = makeAuthFetch((url) => {
      if (String(url).includes('/api/admin/llm/test')) {
        return { ok: true, model: 'claude-3', latencyMs: 123, sample: 'hi' };
      }
      return adminRoutes(url);
    });
    renderWithProviders(h(AdminPage, {}), {
      auth: { authFetch, hasWildcard: true, permissions: new Set(['*']) },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'LLM Settings' }));

    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection OK')).toBeInTheDocument();
  });

  it('shows the empty / not-configured states when risk data is unavailable', async () => {
    const authFetch = makeAuthFetch((url) => {
      if (String(url).includes('/api/admin/risk-profile')) return { available: false };
      if (String(url).includes('/api/admin/classifiers')) return { available: false };
      return adminRoutes(url);
    });
    renderWithProviders(h(AdminPage, {}), {
      auth: { authFetch, hasWildcard: true, permissions: new Set(['*']) },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Risk Scoring' }));

    expect(await screen.findByText(/No risk profile saved yet/)).toBeInTheDocument();
  });

  it('handles an LLM config load error gracefully (no crash, form still renders)', async () => {
    const authFetch = makeAuthFetch((url) => {
      if (String(url).includes('/api/admin/llm/config')) {
        return jsonResponse({ error: 'boom' }, { ok: false, status: 500 });
      }
      return adminRoutes(url);
    });
    renderWithProviders(h(AdminPage, {}), {
      auth: { authFetch, hasWildcard: true, permissions: new Set(['*']) },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'LLM Settings' }));

    // Even on a failed GET the provider card renders (defaults applied).
    expect(await screen.findByText('LLM Provider')).toBeInTheDocument();
  });

  it('switches between the inline sub-tabs without throwing', async () => {
    renderAdmin();
    const user = userEvent.setup();
    // Cycle the inline (non-lazy) sub-tabs — their full render paths execute.
    for (const label of ['Risk Scoring', 'LLM Settings', 'Data']) {
      await user.click(screen.getByRole('button', { name: label }));
    }
    expect(screen.getByRole('heading', { name: 'Admin' })).toBeInTheDocument();
  });

  it('navigates to a lazy child tab (Account Linking) via Suspense', async () => {
    renderAdmin();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Account Linking' }));
    // The Suspense fallback or the loaded child renders — either way the shell stays.
    expect(screen.getByRole('heading', { name: 'Admin' })).toBeInTheDocument();
  });
});
