// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import MatrixScopePanel from './MatrixScopePanel';
import { renderWithProviders, makeAuthFetch, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const filter = {
  rowType: 'principal',
  subject: { include: [], exclude: [] },
  resource: { include: [], exclude: [] },
};

const statsBody = {
  rowType: 'principal',
  subjectCount: 120, resourceCount: 30, assignmentCount: 1500,
  governedAssignmentCount: 900, ungovernedAssignmentCount: 600, governedPct: 60,
};
const seriesBody = {
  points: [
    { date: '2026-05-01', principals: 100, resources: 20, assignments: 1000, governedPct: 55, beforeHistory: false },
    { date: '2026-06-01', principals: 120, resources: 30, assignments: 1500, governedPct: 60, beforeHistory: false },
  ],
  historyStart: '2026-05-01', retentionDays: 90, scopeMode: 'full',
};
const breakdownBody = {
  attribute: 'department',
  groups: [{ group: 'Engineering', principals: 80, assignments: 1000, governed: 600, governedPct: 60 }],
};

function routes() {
  return makeAuthFetch((url) => {
    const u = String(url);
    if (u.includes('/api/matrix/scope-stats')) return statsBody;
    if (u.includes('/api/matrix/scope-timeseries')) return seriesBody;
    if (u.includes('/api/matrix/scope-breakdown')) return breakdownBody;
    return null;
  });
}

describe('MatrixScopePanel (mounted)', () => {
  it('renders nothing without a filter', () => {
    const { container } = renderWithProviders(h(MatrixScopePanel, { filter: null }), { auth: { authFetch: routes() } });
    expect(container).toBeEmptyDOMElement();
  });

  it('loads and shows the live scope stats for the filter', async () => {
    renderWithProviders(h(MatrixScopePanel, { filter }), { auth: { authFetch: routes() } });
    // Debounced fetch resolves; the stat grid (— placeholder while loading) fills in.
    expect(await screen.findByText('120')).toBeInTheDocument(); // subjectCount
    expect(screen.getByText('Principals')).toBeInTheDocument();
    expect(screen.getByText('Assignments')).toBeInTheDocument();
    expect(screen.getByText('900 governed')).toBeInTheDocument();
  });

  it('names each stat tile so its number is announced with its metric', async () => {
    renderWithProviders(h(MatrixScopePanel, { filter }), { auth: { authFetch: routes() } });
    await screen.findByText('120');

    expect(screen.getByRole('group', { name: 'Principals' })).toHaveTextContent('120');
    expect(screen.getByRole('group', { name: 'Resources' })).toHaveTextContent('30');
    expect(screen.getByRole('group', { name: 'Assignments' })).toHaveTextContent('1,500');
  });

  it('expands to fetch the trends timeseries and department breakdown', async () => {
    const authFetch = routes();
    renderWithProviders(h(MatrixScopePanel, { filter }), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('120');
    await user.click(screen.getByText('Trends & breakdown'));

    // The expand triggers both POSTs; wait for the rendered result (department
    // breakdown header) so the trends state settles inside the test.
    expect(await screen.findByText(/By department/i)).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/matrix/scope-timeseries'), expect.anything());
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/matrix/scope-breakdown'), expect.anything());
  });
});
