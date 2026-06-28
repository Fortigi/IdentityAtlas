// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import RunDetailPage from './RunDetailPage';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  userEvent,
} from '@ui/test-utils/renderWithProviders';

const succeededRun = {
  id: 'run-1',
  algorithmName: 'manager-hierarchy',
  algorithmDisplayName: 'Manager Hierarchy',
  status: 'succeeded',
  triggeredBy: 'analyst@example.com',
  startedAt: '2026-06-01T10:00:00Z',
  finishedAt: '2026-06-01T10:00:05Z',
  contextsCreated: 3,
  contextsUpdated: 1,
  contextsRemoved: 0,
  membersAdded: 12,
  membersRemoved: 2,
  parameters: { rootName: 'Org Chart', depth: 5 },
};

function routes(overrides = {}) {
  return makeAuthFetch({ '/api/context-plugins/runs/run-1': succeededRun, ...overrides });
}

const baseProps = { runId: 'run-1', onClose: () => {} };

describe('RunDetailPage (mounted)', () => {
  it('shows the loading state before the run fetch resolves', () => {
    const authFetch = vi.fn(() => new Promise(() => {}));
    renderWithProviders(h(RunDetailPage, baseProps), { auth: { authFetch } });
    expect(screen.getByText(/Loading run/i)).toBeInTheDocument();
  });

  it('renders a succeeded run with reconciliation counts and parameters', async () => {
    renderWithProviders(h(RunDetailPage, baseProps), { auth: { authFetch: routes() } });

    expect(await screen.findByText('Manager Hierarchy')).toBeInTheDocument();
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
    expect(screen.getByText(/Triggered by analyst@example.com/)).toBeInTheDocument();
    // Reconciliation stats.
    expect(screen.getByText('Contexts created')).toBeInTheDocument();
    expect(screen.getByText('Members added')).toBeInTheDocument();
    // Parameters grid.
    expect(screen.getByText('rootName')).toBeInTheDocument();
    expect(screen.getByText('Org Chart')).toBeInTheDocument();
    // Succeeded footer with navigation.
    expect(screen.getByText(/Go there now/)).toBeInTheDocument();
  });

  it('shows the queued banner', async () => {
    const authFetch = routes({
      '/api/context-plugins/runs/run-1': { ...succeededRun, status: 'queued', finishedAt: null },
    });
    renderWithProviders(h(RunDetailPage, baseProps), { auth: { authFetch } });

    expect(await screen.findByText(/Queued\. Waiting to start\./i)).toBeInTheDocument();
  });

  it('shows the failure panel with the error message', async () => {
    const authFetch = routes({
      '/api/context-plugins/runs/run-1': {
        ...succeededRun,
        status: 'failed',
        finishedAt: null,
        errorMessage: 'Something exploded',
      },
    });
    renderWithProviders(h(RunDetailPage, baseProps), { auth: { authFetch } });

    expect(await screen.findByText('Run failed')).toBeInTheDocument();
    expect(screen.getByText('Something exploded')).toBeInTheDocument();
  });

  it('renders the empty parameters message when none were supplied', async () => {
    const authFetch = routes({
      '/api/context-plugins/runs/run-1': { ...succeededRun, parameters: {} },
    });
    renderWithProviders(h(RunDetailPage, baseProps), { auth: { authFetch } });

    expect(await screen.findByText('No parameters were supplied.')).toBeInTheDocument();
  });

  it('renders the error state when the run fetch fails', async () => {
    const authFetch = routes({
      '/api/context-plugins/runs/run-1': jsonResponse({ error: 'boom' }, { ok: false, status: 404 }),
    });
    renderWithProviders(h(RunDetailPage, baseProps), { auth: { authFetch } });

    expect(await screen.findByText('Failed to load run')).toBeInTheDocument();
    expect(screen.getByText('HTTP 404')).toBeInTheDocument();
  });

  it('invokes onClose when the header close button is clicked', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      h(RunDetailPage, { ...baseProps, onClose }),
      { auth: { authFetch: routes() } },
    );
    const user = userEvent.setup();

    await screen.findByText('Manager Hierarchy');
    await user.click(screen.getByRole('button', { name: /Close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
