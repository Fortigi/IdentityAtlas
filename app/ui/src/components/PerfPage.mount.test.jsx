// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import PerfPage from './PerfPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const enabledSummary = {
  enabled: true,
  totalRecorded: 1234,
  bufferSize: 1000,
  endpoints: [
    {
      method: 'GET',
      route: '/api/resources',
      count: 50,
      avg: 150,
      p50: 120,
      p95: 1800,
      p99: 4200,
      min: 30,
      max: 6000,
      sqlBreakdown: [
        { label: 'select resources', count: 3, avg: 90, p50: 80, p95: 110, max: 130 },
      ],
    },
    {
      method: 'POST',
      route: '/api/perf/toggle',
      count: 2,
      avg: 5,
      p50: 5,
      p95: 6,
      p99: 6,
      min: 4,
      max: 7,
      sqlBreakdown: [],
    },
  ],
};

const recentData = {
  data: [
    {
      timestamp: '2026-06-01T10:00:00Z',
      method: 'GET',
      url: '/api/users',
      statusCode: 200,
      totalMs: 250,
      sqlTotalMs: 80,
      sqlQueryCount: 2,
      sqlQueries: [
        { label: 'select users', ms: 40, rows: 12 },
        { label: 'count users', ms: 40, error: 'boom' },
      ],
    },
    {
      timestamp: '2026-06-01T10:01:00Z',
      method: 'POST',
      route: '/api/login',
      statusCode: 500,
      totalMs: 7000,
      sqlTotalMs: 0,
      sqlQueryCount: 0,
      sqlQueries: [],
    },
  ],
};

const slowData = {
  data: [
    {
      timestamp: '2026-06-01T09:00:00Z',
      method: 'GET',
      url: '/api/matrix',
      statusCode: 200,
      totalMs: 9000,
      sqlTotalMs: 5000,
      sqlQueryCount: 1,
      sqlQueries: [{ label: 'big query', ms: 5000, rows: 9999 }],
    },
  ],
};

function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/perf/recent': recentData,
    '/api/perf/slow': slowData,
    '/api/perf/export': { ...jsonResponse({ exported: true }), blob: async () => new Blob(['{}']) },
    '/api/perf/clear': { ok: true },
    '/api/perf/toggle': { ok: true },
    '/api/perf': enabledSummary,
    ...overrides,
  });
}

beforeEach(() => {
  // handleExport reads res.blob() and uses URL.createObjectURL — stub the bits jsdom lacks.
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe('PerfPage (mounted)', () => {
  it('renders the disabled state when metrics are off and can enable them', async () => {
    const authFetch = makeAuthFetch({
      '/api/perf/recent': { data: [] },
      '/api/perf/slow': { data: [] },
      '/api/perf/toggle': { ok: true },
      '/api/perf': { enabled: false },
    });
    renderWithProviders(h(PerfPage), { auth: { authFetch } });

    expect(await screen.findByText('Performance Monitoring Disabled')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByText('Enable Performance Monitoring'));
    expect(authFetch).toHaveBeenCalledWith(
      '/api/perf/toggle',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('renders the enabled summary with endpoint stats', async () => {
    renderWithProviders(h(PerfPage), { auth: { authFetch: routes() } });

    expect(await screen.findByText('Performance Metrics')).toBeInTheDocument();
    expect(screen.getByText(/1234 requests recorded/)).toBeInTheDocument();
    expect(screen.getByText('/api/resources')).toBeInTheDocument();
    // avg 150ms formatted, p95 1800 -> 1.80s
    expect(screen.getByText('150.0ms')).toBeInTheDocument();
    expect(screen.getByText('1.80s')).toBeInTheDocument();
  });

  it('expands an endpoint row to show its SQL breakdown', async () => {
    renderWithProviders(h(PerfPage), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    const routeCell = await screen.findByText('/api/resources');
    await user.click(routeCell);
    expect(await screen.findByText('SQL: select resources')).toBeInTheDocument();
    expect(screen.getByText('3x')).toBeInTheDocument();
  });

  it('switches to the Recent Requests tab and expands a request', async () => {
    renderWithProviders(h(PerfPage), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Performance Metrics');
    await user.click(screen.getByText('Recent Requests'));

    const urlCell = await screen.findByText('/api/users');
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    await user.click(urlCell);
    expect(await screen.findByText('select users')).toBeInTheDocument();
    expect(screen.getByText('(12 rows)')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('switches to the Slowest Requests tab', async () => {
    renderWithProviders(h(PerfPage), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Performance Metrics');
    await user.click(screen.getByText('Slowest Requests'));
    expect(await screen.findByText('/api/matrix')).toBeInTheDocument();
  });

  it('exports, clears, refreshes and disables via the header buttons', async () => {
    const authFetch = routes();
    renderWithProviders(h(PerfPage), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Performance Metrics');

    await user.click(screen.getByRole('button', { name: 'Export JSON' }));
    expect(authFetch).toHaveBeenCalledWith('/api/perf/export');

    await user.click(screen.getByText('Clear'));
    expect(authFetch).toHaveBeenCalledWith('/api/perf/clear', expect.objectContaining({ method: 'POST' }));

    await user.click(screen.getByText('Disable'));
    expect(authFetch).toHaveBeenCalledWith(
      '/api/perf/toggle',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ enabled: false }) }),
    );

    await user.click(screen.getByText('Refresh'));
    expect(authFetch).toHaveBeenCalledWith('/api/perf');
  });

  it('toggles auto-refresh on', async () => {
    renderWithProviders(h(PerfPage), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Performance Metrics');
    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it('shows the empty endpoint state when no endpoints are recorded', async () => {
    const authFetch = routes({ '/api/perf': { ...enabledSummary, endpoints: [] } });
    renderWithProviders(h(PerfPage), { auth: { authFetch } });

    expect(await screen.findByText(/No requests recorded yet/i)).toBeInTheDocument();
  });
});
