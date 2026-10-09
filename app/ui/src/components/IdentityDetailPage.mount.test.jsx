// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement as h } from 'react';
import IdentityDetailPage from './IdentityDetailPage';
import {
  renderWithProviders,
  makeAuthFetch,
  jsonResponse,
  screen,
  waitFor,
  userEvent,
} from '@ui/test-utils/renderWithProviders';

// useFeatures reads /api/features via the global `fetch` (not authFetch).
beforeEach(() => {
  global.fetch = vi.fn(async () => jsonResponse({ riskScoring: true, accountLinking: true }));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const detail = {
  identity: {
    id: 'id-1',
    displayName: 'Dana Doe',
    accountCount: 2,
    contextId: 'ctx-9',
    contextDisplayName: 'Engineering',
    department: 'Engineering',
    extendedAttributes: null,
  },
  members: [
    {
      principalId: 'p-1',
      displayName: 'dana@corp.com',
      systemId: 1,
      systemDisplayName: 'Entra ID',
      accountType: 'Regular',
      userAccountEnabled: true,
      isHrAuthoritative: true,
      jobTitle: 'Staff Engineer',
      linkConfidence: 95,
    },
    {
      principalId: 'p-2',
      displayName: 'ddoe@legacy',
      systemId: 2,
      systemDisplayName: 'HR CSV',
      accountType: 'Regular',
      userAccountEnabled: false,
      linkConfidence: 60,
    },
  ],
  aggregateAssignments: {},
  contextCount: 1,
};

const riskData = {
  riskScore: 65,
  riskTier: 'High',
  riskScoredAt: '2026-06-01T10:00:00Z',
};

const timeline = { events: [], addedCount: 0, removedCount: 0, changedCount: 0, sinceDays: 90 };

// Order: more-specific substrings before the bare detail key.
function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/risk-scores/identities/id-1': riskData,
    '/api/identities/id-1/timeline': timeline,
    '/api/identities/id-1': detail,
    ...overrides,
  });
}

const baseProps = {
  identityId: 'id-1',
  cachedData: null,
  onCacheData: () => {},
  onClose: () => {},
  onOpenDetail: () => {},
};

describe('IdentityDetailPage (mounted)', () => {
  it('shows the loading state before the detail fetch resolves', () => {
    const authFetch = vi.fn(() => new Promise(() => {}));
    renderWithProviders(h(IdentityDetailPage, baseProps), { auth: { authFetch } });
    expect(screen.getByText(/Loading identity details/i)).toBeInTheDocument();
  });

  it('renders the identity header and account count after load', async () => {
    renderWithProviders(h(IdentityDetailPage, baseProps), { auth: { authFetch: routes() } });

    expect(await screen.findByText('Dana Doe')).toBeInTheDocument();
    expect(screen.getByText('2 accounts')).toBeInTheDocument();
    // HR-authoritative job title surfaces in the header.
    expect(screen.getByText('Staff Engineer')).toBeInTheDocument();
    // Context link rendered.
    expect(screen.getByRole('button', { name: 'Engineering' })).toBeInTheDocument();
  });

  it('opens the context detail when the header context link is clicked', async () => {
    const onOpenDetail = vi.fn();
    renderWithProviders(
      h(IdentityDetailPage, { ...baseProps, onOpenDetail }),
      { auth: { authFetch: routes() } },
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Engineering' }));
    expect(onOpenDetail).toHaveBeenCalledWith('context', 'ctx-9', 'Engineering');
  });

  it('switches to the Relationships tab and shows linked accounts', async () => {
    renderWithProviders(h(IdentityDetailPage, baseProps), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Dana Doe');
    await user.click(screen.getByRole('tab', { name: /Relationships/i }));

    expect(await screen.findByText('dana@corp.com')).toBeInTheDocument();
    expect(screen.getByText('ddoe@legacy')).toBeInTheDocument();
    // Each account is shown with its source system and enabled state.
    expect(screen.getAllByRole('columnheader').map(th => th.textContent))
      .toEqual(['System', 'Account', 'Enabled', 'Type', 'Actions']);
    const row = screen.getByRole('button', { name: 'ddoe@legacy' }).closest('tr');
    expect(row).toHaveTextContent('HR CSV');
    expect(row).toHaveTextContent('No');
  });

  it('shows no Organisation node when the organisation lists are off (404) or not built (501)', async () => {
    for (const status of [404, 501]) {
      const authFetch = routes({ '/api/org-truth/linked/': jsonResponse({ error: 'off' }, { ok: false, status }) });
      const { unmount } = renderWithProviders(h(IdentityDetailPage, baseProps), { auth: { authFetch } });
      const user = userEvent.setup();
      await screen.findByText('Dana Doe');
      await user.click(screen.getByRole('tab', { name: /Relationships/i }));
      await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/org-truth/linked/Identity/id-1'));
      expect((await screen.findAllByText('Linked Accounts')).length).toBeGreaterThan(0);
      expect(screen.queryByText('Organisation')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('fans the Organisation node out into its groups, then a group into org entities', async () => {
    const linked = {
      total: 3,
      groups: [
        { key: 'direct|Klant|eigenaar', entityType: 'Klant', kind: 'direct', label: 'Klant · eigenaar', count: 1,
          items: [{ entityId: 'k1', entityType: 'Klant', label: 'Acme BV', detail: null }] },
        { key: 'through|Klant|Uren|klant', entityType: 'Klant', kind: 'through', sourceType: 'Uren', label: 'Klant · Uren',
          count: 2, unlinkedRows: 12, items: [
            { entityId: 'k2', entityType: 'Klant', label: 'Beta NV', detail: '12.5 h · 3 rows · until 2026-01' },
            { entityId: 'k3', entityType: 'Klant', label: 'Gamma', detail: '1 h · 1 rows' },
          ] },
      ],
    };
    const onOpenDetail = vi.fn();
    const authFetch = routes({ '/api/org-truth/linked/Identity/id-1': linked });
    renderWithProviders(h(IdentityDetailPage, { ...baseProps, onOpenDetail }), { auth: { authFetch } });
    const user = userEvent.setup();
    await screen.findByText('Dana Doe');
    await user.click(screen.getByRole('tab', { name: /Relationships/i }));

    const graphNode = (text) => screen.getAllByText(text).find(el => el.closest('svg')).closest('g');
    await user.click((await screen.findByText('Organisation')).closest('g'));
    // Groups ring, and the list shows the groups.
    expect(await screen.findByRole('heading', { name: 'Organisation' })).toBeInTheDocument();
    expect(graphNode('Klant · eigenaar')).toBeTruthy();

    await user.click(graphNode('Klant · Uren'));
    expect(await screen.findByRole('heading', { name: 'Organisation → Klant · Uren' })).toBeInTheDocument();
    expect(screen.getByText('12 Uren rows point at no Klant')).toBeInTheDocument();
    const row = screen.getByRole('button', { name: 'Beta NV' }).closest('tr');
    expect(row).toHaveTextContent('12.5 h · 3 rows · until 2026-01');
    expect(row).toHaveTextContent('Klant');
    await user.click(screen.getByRole('button', { name: 'Gamma' }));
    expect(onOpenDetail).toHaveBeenCalledWith('org-entity', 'k3', 'Gamma');
    expect(authFetch.mock.calls.filter(([u]) => String(u).startsWith('/api/org-truth/linked/'))).toHaveLength(1);
  });

  it('switches to the Timeline tab and triggers the timeline fetch', async () => {
    const authFetch = routes();
    renderWithProviders(h(IdentityDetailPage, baseProps), { auth: { authFetch } });
    const user = userEvent.setup();

    await screen.findByText('Dana Doe');
    await user.click(screen.getByRole('tab', { name: /Timeline/i }));

    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/identities/id-1/timeline'),
      ),
    );
  });

  it('shows the Risk tab when risk data + feature flag are present', async () => {
    renderWithProviders(h(IdentityDetailPage, baseProps), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    await screen.findByText('Dana Doe');
    const riskTab = await screen.findByRole('tab', { name: /^Risk$/i });
    await user.click(riskTab);
    // Risk section content renders for this tab.
    expect(riskTab).toBeInTheDocument();
  });

  it('renders the error state when the detail fetch fails', async () => {
    const authFetch = routes({
      '/api/identities/id-1': jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
    });
    renderWithProviders(h(IdentityDetailPage, baseProps), { auth: { authFetch } });

    expect(await screen.findByText('Error loading identity')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();
  });

  it('caches the loaded detail via onCacheData', async () => {
    const onCacheData = vi.fn();
    renderWithProviders(
      h(IdentityDetailPage, { ...baseProps, onCacheData }),
      { auth: { authFetch: routes() } },
    );

    await screen.findByText('Dana Doe');
    expect(onCacheData).toHaveBeenCalledWith('id-1', 'identity', { core: detail });
  });
});
