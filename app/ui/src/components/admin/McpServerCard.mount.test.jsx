// @vitest-environment jsdom
//
// Admin → Experimental → MCP server. What this pins down:
//   • off: no activity is fetched, the switch POSTs mcpServer=true
//   • the server's refusal (sign-in off) is shown, and nothing reloads
//   • on: the URL and scope to configure an assistant with, and the recent calls
//   • an empty log and an unreadable log each say so
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import McpServerCard from './McpServerCard';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent, waitFor,
} from '@ui/test-utils/renderWithProviders';

let reload;
beforeEach(() => {
  reload = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload, hash: '' } });
});

const STATUS = {
  url: 'https://atlas.example.com/mcp',
  scope: 'https://atlas.example.com/mcp/Mcp.Read',
  calls: [{ id: 7, calledAt: '2026-10-29T10:00:00Z', userName: 'ada@example.com', tool: 'run_report', outcome: 'ok', rowCount: 12 }],
};

function render(mcpServer, routes) {
  const authFetch = makeAuthFetch(routes);
  renderWithProviders(h(McpServerCard, { features: { mcpServer } }), { auth: { authFetch } });
  return authFetch;
}

describe('McpServerCard', () => {
  it('when off, fetches no activity and switches on with the right feature name', async () => {
    const authFetch = render(false, { '/api/admin/features/toggle': {} });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText('Server URL:')).toBeNull();
    await userEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    const [url, opts] = authFetch.mock.calls.find(([u]) => u.includes('/features/toggle'));
    expect(url).toBe('/api/admin/features/toggle');
    expect(JSON.parse(opts.body)).toEqual({ feature: 'mcpServer', enabled: true });
    expect(authFetch.mock.calls.some(([u]) => u.includes('/api/admin/mcp'))).toBe(false);
  });

  it('shows why the server refused to switch it on, and does not reload', async () => {
    render(false, {
      '/api/admin/features/toggle': jsonResponse({ error: 'Turn on authentication first' }, { ok: false, status: 409 }),
    });
    await userEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText('Turn on authentication first')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('when on, shows the URL, the scope and the recent calls', async () => {
    const authFetch = render(true, { '/api/admin/mcp': STATUS });
    expect(await screen.findByText('https://atlas.example.com/mcp')).toBeInTheDocument();
    expect(screen.getByText('https://atlas.example.com/mcp/Mcp.Read')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('run_report')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(authFetch.mock.calls[0][0]).toBe('/api/admin/mcp?limit=20');
  });

  it('says so when no assistant has used it yet', async () => {
    render(true, { '/api/admin/mcp': { ...STATUS, calls: [] } });
    expect(await screen.findByText('No assistant has used it yet.')).toBeInTheDocument();
  });

  it('says so when the log cannot be read', async () => {
    render(true, { '/api/admin/mcp': jsonResponse({}, { ok: false, status: 500 }) });
    expect(await screen.findByText(/Could not load the activity log \(HTTP 500\)/)).toBeInTheDocument();
  });

  it('keeps the switch disabled until the features have loaded', () => {
    renderWithProviders(h(McpServerCard, { features: null }), { auth: { authFetch: makeAuthFetch({}) } });
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
