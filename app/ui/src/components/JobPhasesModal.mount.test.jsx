// @vitest-environment jsdom
//
// Mount tests for the crawler job-detail modal (JobPhasesModal). Guards issue
// #765: the modal must render its dark-mode chrome so it is readable when the
// dark theme is active. Because the modal is a large pure-JSX return, these
// mount tests execute the real component and assert the actual classes on the
// rendered nodes — a class removal that would re-break dark mode fails here.

import { describe, it, expect } from 'vitest';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  userEvent,
  waitFor,
} from '@ui/test-utils/renderWithProviders';
import { JobPhasesModal } from '@ui/components/JobPhasesModal';

const completedJob = {
  id: 42,
  jobType: 'sample',
  status: 'completed',
  createdAt: '2026-07-16T10:00:00Z',
  phases: [
    { name: 'SyncUsers', status: 'ok', durationMs: 1200, records: { users: 5 } },
    { name: 'SyncGroups', status: 'failed', durationMs: 300, error: 'boom' },
    // 'skipped' status + a minutes-scale duration exercise the skipped dot and
    // the fmtMs minutes branch; the trailing phase with an unknown status +
    // neither error nor records hits the fallback dot and the em-dash detail.
    { name: 'SyncApps', status: 'skipped', durationMs: 65000 },
    { name: 'SyncTeams', status: 'pending' },
  ],
};

// The modal's outermost child of the backdrop is the panel card. Grab it by the
// heading and walk up to the element that carries the panel background class.
function panelOf() {
  const heading = screen.getByText(/Job 42 — sample/).closest('div');
  return heading.closest('.bg-white');
}

describe('JobPhasesModal dark mode', () => {
  it('renders the job header and phases', () => {
    renderWithProviders(<JobPhasesModal job={completedJob} onClose={() => {}} />);
    expect(screen.getByText(/Job 42 — sample/)).toBeInTheDocument();
    expect(screen.getByText('SyncUsers')).toBeInTheDocument();
    expect(screen.getByText('SyncGroups')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('gives the modal panel a dark-mode background and border', () => {
    renderWithProviders(<JobPhasesModal job={completedJob} onClose={() => {}} />);
    const panel = panelOf();
    expect(panel).toBeTruthy();
    // The regression this guards: panel must carry the dark surface + base text.
    expect(panel.className).toContain('dark:bg-gray-800');
    expect(panel.className).toContain('dark:text-gray-100');
  });

  it('dark-themes the phases table header and the failed row', () => {
    const { container } = renderWithProviders(
      <JobPhasesModal job={completedJob} onClose={() => {}} />,
    );
    const thead = container.querySelector('thead');
    expect(thead.className).toContain('dark:bg-gray-700/50');
    // The failed phase row is tinted; it must have a dark tint too.
    const failedRow = screen.getByText('SyncGroups').closest('tr');
    expect(failedRow.className).toContain('dark:bg-red-900/20');
  });

  it('dark-themes the fallback errorMessage when there are no phases', () => {
    const legacyJob = {
      id: 7,
      jobType: 'legacy',
      status: 'failed',
      createdAt: '2026-07-16T10:00:00Z',
      phases: [],
      errorMessage: 'legacy failure',
    };
    renderWithProviders(<JobPhasesModal job={legacyJob} onClose={() => {}} />);
    const pre = screen.getByText('legacy failure');
    expect(pre.className).toContain('dark:bg-red-900/20');
    expect(pre.className).toContain('dark:text-red-300');
  });

  it('dark-themes the full/delta sync-mode badges', () => {
    const fullJob = { ...completedJob, config: { _syncMode: 'full' } };
    const { unmount } = renderWithProviders(<JobPhasesModal job={fullJob} onClose={() => {}} />);
    const full = screen.getByText('full');
    expect(full.className).toContain('dark:bg-amber-900/30');
    expect(full.className).toContain('dark:text-amber-300');
    unmount();

    const deltaJob = { ...completedJob, config: { _syncMode: 'delta' } };
    renderWithProviders(<JobPhasesModal job={deltaJob} onClose={() => {}} />);
    const delta = screen.getByText('delta');
    expect(delta.className).toContain('dark:bg-slate-700');
    expect(delta.className).toContain('dark:text-slate-300');
  });

  it('dark-themes the trace pane when the Trace tab is opened', async () => {
    const authFetch = makeAuthFetch((url) =>
      String(url).includes('/log')
        ? jsonResponse({ text: 'line one\nline two', totalLength: 2048, exists: true, truncated: false })
        : jsonResponse({ error: 'nope' }, { ok: false, status: 404 }),
    );
    renderWithProviders(<JobPhasesModal job={completedJob} onClose={() => {}} />, {
      auth: { authFetch },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Trace' }));
    const pre = await screen.findByText(/line one/);
    // The trace pane keeps its terminal look but gains a dark-mode surface.
    expect(pre.className).toContain('dark:bg-black');
    // The size readout formats the byte count (2048 → "2.0 KB").
    expect(await screen.findByText(/2\.0 KB/)).toBeInTheDocument();
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
  });

  it('shows a trace error when the log fetch fails', async () => {
    const authFetch = makeAuthFetch((url) =>
      String(url).includes('/log')
        ? jsonResponse({ error: 'nope' }, { ok: false, status: 500 })
        : jsonResponse({ error: 'nope' }, { ok: false, status: 404 }),
    );
    renderWithProviders(<JobPhasesModal job={completedJob} onClose={() => {}} />, {
      auth: { authFetch },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Trace' }));
    expect(await screen.findByText(/Failed to refresh trace/)).toBeInTheDocument();
  });

  it('renders nothing when no job is supplied', () => {
    const { container } = renderWithProviders(<JobPhasesModal job={null} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
