// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import RiskScoringPage from './RiskScoringPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, fireEvent, waitFor, userEvent } from '@ui/test-utils/renderWithProviders';

// ─── Fixtures ────────────────────────────────────────────────────────

const summary = {
  available: true,
  scoredAt: '2026-06-20T12:00:00Z',
  summary: {
    totalGroups: 3,
    totalUsers: 4,
    totalBusinessRoles: 2,
    totalContexts: 2,
    totalIdentities: 2,
    groupsByTier: { Critical: 1, High: 1, Low: 1 },
    usersByTier: { High: 2, Medium: 1, Minimal: 1 },
    businessRolesByTier: { Critical: 1, Medium: 1 },
    contextsByTier: { High: 1, Low: 1 },
    identitiesByTier: { Critical: 1, Low: 1 },
    groupOverrides: 1,
    userOverrides: 1,
    businessRoleOverrides: 0,
    contextOverrides: 0,
    identityOverrides: 0,
    topGroups: [
      { id: 'g1', displayName: 'Domain Admins', effectiveScore: 95, riskTier: 'Critical', riskOverride: 10 },
      { id: 'g2', displayName: 'Helpdesk', riskScore: 30, riskTier: 'Low', riskOverride: -5 },
    ],
    topUsers: [
      { id: 'u1', displayName: 'Alice Admin', effectiveScore: 88, riskTier: 'High', riskOverride: 5 },
      { id: 'u2', displayName: 'Bob User', riskScore: 20, riskTier: 'Minimal' },
    ],
  },
};

const usersList = {
  total: 60,
  data: [
    {
      id: 'u1',
      displayName: 'Alice Admin',
      department: 'IT',
      jobTitle: 'Sysadmin',
      effectiveScore: 88,
      riskTier: 'High',
      riskOverride: 5,
      riskOverrideReason: 'manual bump',
      classifierMatches: [
        { id: 'm1', label: 'PrivilegedRole', tier: 'Critical', score: 40 },
        { id: 'm2', label: 'StaleAccount', tier: 'Medium', score: 10 },
        { id: 'm3', label: 'ExternalGuest', tier: 'Low', score: 5 },
        { id: 'm4', label: 'Extra', tier: 'Low', score: 1 },
      ],
    },
    {
      id: 'u2',
      displayName: 'Bob User',
      riskScore: 20,
      riskTier: 'Minimal',
      riskMembershipScore: 3,
      classifierMatches: '[]',
    },
  ],
};

const groupsList = {
  total: 2,
  data: [
    {
      id: 'g1',
      displayName: 'Domain Admins',
      description: 'Highly privileged group',
      effectiveScore: 95,
      riskTier: 'Critical',
      classifierMatches: 'not-json',
    },
  ],
};

function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/risk-scores/cluster-summary': { available: false },
    '/api/risk-scores/users': usersList,
    '/api/risk-scores/groups': groupsList,
    '/api/risk-scores/business-roles': {
      total: 1,
      data: [
        { id: 'br1', displayName: 'Finance Approver', description: 'Approves invoices', catalogName: 'Finance Catalog', riskScore: 50, riskTier: 'Medium', classifierMatches: [], riskMembershipScore: 0 },
      ],
    },
    '/api/risk-scores/contexts': {
      total: 1,
      data: [
        { id: 'ctx1', displayName: 'Sales Team', department: 'Sales', memberCount: 12, managerName: 'Carol Manager', effectiveScore: 65, riskTier: 'High', classifierMatches: [], riskMembershipScore: 0 },
      ],
    },
    '/api/risk-scores/identities': { total: 0, data: [] },
    '/api/risk-scores': summary,
    ...overrides,
  });
}

describe('RiskScoringPage (mounted)', () => {
  it('shows the loading state before the summary resolves', () => {
    // authFetch that never resolves keeps loading=true.
    const authFetch = vi.fn(() => new Promise(() => {}));
    renderWithProviders(h(RiskScoringPage), { auth: { authFetch } });
    expect(screen.getByText('Loading risk scores...')).toBeInTheDocument();
  });

  it('renders summary, distribution charts, top-risk lists and the default users table', async () => {
    renderWithProviders(h(RiskScoringPage, { onOpenDetail: () => {} }), { auth: { authFetch: routes() } });

    expect(await screen.findByText('Identity Risk Scores')).toBeInTheDocument();
    // Override count in the header (1 group + 1 user = 2).
    expect(screen.getByText(/2 analyst overrides/)).toBeInTheDocument();
    // Distribution chart label + Resources tab button both say "Resources".
    expect(screen.getAllByText('Resources').length).toBeGreaterThan(0);
    expect(screen.getByText('Top Risk Resources')).toBeInTheDocument();
    expect(screen.getByText('Top Risk Users')).toBeInTheDocument();
    // Default users table loads (effect fetch). "Sysadmin" (jobTitle) is table-only.
    expect(await screen.findByText('Sysadmin')).toBeInTheDocument();
    // Classifier match chips (first 3 + overflow "+1").
    expect(screen.getByText('PrivilegedRole')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    // small-group bonus shown for u2 (no matches, membershipScore>0).
    expect(screen.getByText('small-group bonus')).toBeInTheDocument();
  });

  it('shows the not-available notice when scores have not been computed', async () => {
    renderWithProviders(h(RiskScoringPage), {
      auth: { authFetch: routes({ '/api/risk-scores': { available: false } }) },
    });
    expect(await screen.findByText('Risk Scores Not Yet Computed')).toBeInTheDocument();
  });

  it('shows an error panel and retries when the summary fetch fails', async () => {
    const authFetch = routes({ '/api/risk-scores': jsonResponse({}, { ok: false, status: 500 }) });
    renderWithProviders(h(RiskScoringPage), { auth: { authFetch } });

    expect(await screen.findByText('Error')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText('Retry'));
    // Retry re-invokes the summary endpoint.
    expect(authFetch).toHaveBeenCalledWith('/api/risk-scores');
  });

  it('switches to the Resources view and fetches the groups list', async () => {
    const authFetch = routes();
    renderWithProviders(h(RiskScoringPage, { onOpenDetail: () => {} }), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Sysadmin');
    await user.click(screen.getByRole('button', { name: 'Resources' }));

    // "Highly privileged group" (the description) is table-only, so it confirms the groups table rendered.
    expect(await screen.findByText('Highly privileged group')).toBeInTheDocument();
    const calledUrls = authFetch.mock.calls.map(c => String(c[0]));
    expect(calledUrls.some(u => u.includes('/api/risk-scores/groups'))).toBe(true);
  });

  it('applies tier filter, search and overrides-only into the entity query', async () => {
    const authFetch = routes();
    renderWithProviders(h(RiskScoringPage, { onOpenDetail: () => {} }), { auth: { authFetch } });

    await screen.findByText('Sysadmin');

    fireEvent.change(screen.getByDisplayValue('All tiers'), { target: { value: 'High' } });
    // The search field is reachable by its accessible name (aria-label), not
    // just its placeholder — guards #761.
    fireEvent.change(screen.getByRole('textbox', { name: /Search users/i }), { target: { value: 'alice' } });
    fireEvent.click(screen.getByRole('checkbox'));

    await screen.findByText('Sysadmin');
    const calledUrls = authFetch.mock.calls.map(c => String(c[0]));
    expect(calledUrls.some(u => u.includes('tier=High'))).toBe(true);
    expect(calledUrls.some(u => u.includes('search=alice'))).toBe(true);
    expect(calledUrls.some(u => u.includes('overridesOnly=true'))).toBe(true);
  });

  it('paginates when the result total exceeds one page', async () => {
    const authFetch = routes();
    renderWithProviders(h(RiskScoringPage, { onOpenDetail: () => {} }), { auth: { authFetch } });

    await screen.findByText('Sysadmin');
    // total=60, PAGE_SIZE=25 → 3 pages, so Next/Prev render.
    const nextBtn = screen.getByRole('button', { name: 'Next' });
    expect(nextBtn).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(nextBtn);
    const calledUrls = authFetch.mock.calls.map(c => String(c[0]));
    expect(calledUrls.some(u => u.includes('offset=25'))).toBe(true);
  });

  it('resets to the first page when a filter changes after paginating', async () => {
    // Regression guard for the render-time page-reset: after paginating to
    // page 2 (offset 25), changing a filter must drop back to page 1 (offset 0),
    // not keep the now-stale offset.
    const authFetch = routes();
    renderWithProviders(h(RiskScoringPage, { onOpenDetail: () => {} }), { auth: { authFetch } });
    const user = userEvent.setup();
    await screen.findByText('Sysadmin');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(authFetch.mock.calls.some(c => String(c[0]).includes('offset=25'))).toBe(true));

    authFetch.mockClear();
    fireEvent.change(screen.getByPlaceholderText(/Search users/i), { target: { value: 'alice' } });

    await waitFor(() => {
      const urls = authFetch.mock.calls.map(c => String(c[0]));
      expect(urls.some(u => u.includes('search=alice') && u.includes('offset=0'))).toBe(true);
    });
    // And crucially NOT the stale page-2 offset.
    const urls = authFetch.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('search=alice') && u.includes('offset=25'))).toBe(false);
  });

  it('invokes onOpenDetail when an entity row is clicked', async () => {
    const onOpenDetail = vi.fn();
    renderWithProviders(h(RiskScoringPage, { onOpenDetail }), { auth: { authFetch: routes() } });

    // "Sysadmin" (jobTitle) is table-only and sits in Alice's row; clicking it fires the row onClick.
    const cell = await screen.findByText('Sysadmin');
    const user = userEvent.setup();
    await user.click(cell);
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'u1', 'Alice Admin');
  });

  it('renders the empty entity table when a view has no rows', async () => {
    const authFetch = routes({ '/api/risk-scores/business-roles': { total: 0, data: [] } });
    renderWithProviders(h(RiskScoringPage, { onOpenDetail: () => {} }), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Sysadmin');
    await user.click(screen.getByRole('button', { name: 'Business Roles' }));

    expect(await screen.findByText('No entities match the current filters')).toBeInTheDocument();
  });

  it('switches through Business Roles and Contexts views rendering their extra columns', async () => {
    const authFetch = routes();
    renderWithProviders(h(RiskScoringPage, { onOpenDetail: () => {} }), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Sysadmin');

    await user.click(screen.getByRole('button', { name: 'Business Roles' }));
    expect(await screen.findByText('Finance Approver')).toBeInTheDocument();
    expect(screen.getByText('Finance Catalog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Contexts' }));
    expect(await screen.findByText('Sales Team')).toBeInTheDocument();
    expect(screen.getByText('Carol Manager')).toBeInTheDocument();
  });

  it('renders entity-type-specific columns for the identities view', async () => {
    const identitiesList = {
      total: 1,
      data: [
        {
          id: 'i1',
          displayName: 'Jane Person',
          accountCount: 3,
          department: 'Finance',
          linkConfidence: 0.82,
          effectiveScore: 70,
          riskTier: 'High',
          classifierMatches: [],
          riskMembershipScore: 0,
        },
      ],
    };
    const authFetch = routes({ '/api/risk-scores/identities': identitiesList });
    renderWithProviders(h(RiskScoringPage, { onOpenDetail: () => {} }), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Sysadmin');
    await user.click(screen.getByRole('button', { name: 'Identities' }));

    expect(await screen.findByText('Jane Person')).toBeInTheDocument();
    // Identity-specific columns: account count and rounded link confidence.
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('82%')).toBeInTheDocument();
  });
});
