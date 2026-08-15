// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import LLMSettingsSection from './LLMSettingsSection';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  userEvent,
} from '@ui/test-utils/renderWithProviders';

// A configured tenant: a saved anthropic config with a stored key. Individual
// tests layer specific PUT/POST/DELETE/models responses on top via `extra`.
function llmRoutes(extra = {}) {
  return (url, opts) => {
    const u = String(url);
    for (const [key, val] of Object.entries(extra)) {
      if (u.includes(key)) return typeof val === 'function' ? val(u, opts) : val;
    }
    if (u.includes('/api/admin/llm/config')) {
      return {
        providers: ['anthropic', 'openai', 'azure-openai'],
        defaultModels: { anthropic: 'claude-3', openai: 'gpt-4o' },
        apiKeySet: true,
        config: { provider: 'anthropic', model: 'claude-3', endpoint: '', deployment: '', apiVersion: '' },
      };
    }
    return {};
  };
}

function render(extra) {
  return renderWithProviders(h(LLMSettingsSection, {}), {
    auth: { authFetch: makeAuthFetch(llmRoutes(extra)), hasWildcard: true, permissions: new Set(['*']) },
  });
}

describe('LLMSettingsSection (mounted)', () => {
  it('renders the form seeded from the saved config with the stored-key badge', async () => {
    render();
    expect(await screen.findByText('LLM Provider')).toBeInTheDocument();
    expect(screen.getByText(/stored/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Anthropic Claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('saves the config and shows a success message', async () => {
    render({ '/api/admin/llm/config': (u, opts) => {
      if (opts?.method === 'PUT') return jsonResponse({ ok: true });
      return llmRoutes()(u, opts);
    } });
    const user = userEvent.setup();
    await screen.findByText('LLM Provider');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('LLM settings saved')).toBeInTheDocument();
  });

  it('surfaces a save error from the server', async () => {
    render({ '/api/admin/llm/config': (u, opts) => {
      if (opts?.method === 'PUT') return jsonResponse({ error: 'bad key' }, { ok: false, status: 400 });
      return llmRoutes()(u, opts);
    } });
    const user = userEvent.setup();
    await screen.findByText('LLM Provider');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('bad key')).toBeInTheDocument();
  });

  it('runs a successful connection test and shows the result panel', async () => {
    render({ '/api/admin/llm/test': { ok: true, model: 'claude-3', latencyMs: 42, sample: 'hi there' } });
    const user = userEvent.setup();
    await screen.findByText('LLM Provider');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection OK')).toBeInTheDocument();
    expect(screen.getByText(/hi there/)).toBeInTheDocument();
  });

  it('shows a failed connection test', async () => {
    render({ '/api/admin/llm/test': { ok: false, error: 'unauthorized' } });
    const user = userEvent.setup();
    await screen.findByText('LLM Provider');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection failed')).toBeInTheDocument();
    expect(screen.getByText('unauthorized')).toBeInTheDocument();
  });

  it('discovers models and switches the field to a dropdown', async () => {
    render({ '/api/admin/llm/models': { ok: true, models: [{ id: 'm1', label: 'Model One' }, { id: 'm2' }] } });
    const user = userEvent.setup();
    await screen.findByText('LLM Provider');
    await user.click(screen.getByRole('button', { name: 'Discover models' }));
    expect(await screen.findByRole('option', { name: 'Model One' })).toBeInTheDocument();
    // A model with no label falls back to its id.
    expect(screen.getByRole('option', { name: 'm2' })).toBeInTheDocument();
  });

  it('shows a discovery error when model fetch fails', async () => {
    render({ '/api/admin/llm/models': { ok: false, error: 'no permission' } });
    const user = userEvent.setup();
    await screen.findByText('LLM Provider');
    await user.click(screen.getByRole('button', { name: 'Discover models' }));
    expect(await screen.findByText(/Model discovery failed: no permission/)).toBeInTheDocument();
  });

  it('reveals the Azure fields when the provider switches to azure-openai', async () => {
    render();
    const user = userEvent.setup();
    await screen.findByText('LLM Provider');
    await user.selectOptions(screen.getByRole('combobox', { name: 'LLM provider' }), 'azure-openai');
    expect(await screen.findByText('Azure endpoint')).toBeInTheDocument();
    expect(screen.getByText('API version')).toBeInTheDocument();
  });

  it('clears the configuration through the confirm dialog', async () => {
    render({ '/api/admin/llm/config': (u, opts) => {
      if (opts?.method === 'DELETE') return jsonResponse({ ok: true });
      return llmRoutes()(u, opts);
    } });
    const user = userEvent.setup();
    await screen.findByText('LLM Provider');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await screen.findByText('Clear the LLM configuration and stored API key?');
    const clears = screen.getAllByRole('button', { name: 'Clear' });
    await user.click(clears[clears.length - 1]);
    expect(await screen.findByText('LLM configuration cleared')).toBeInTheDocument();
    // The stored badge and the Clear action button both disappear once cleared.
    expect(screen.queryByText(/stored/)).not.toBeInTheDocument();
  });
});
