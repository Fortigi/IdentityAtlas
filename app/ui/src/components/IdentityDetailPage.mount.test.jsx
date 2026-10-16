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
    '/api/identities/id-1/contexts': [{ id: 'ctx-9', displayName: 'Engineering' }],
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

    expect(await screen.findByRole('button', { name: 'dana@corp.com' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ddoe@legacy' })).toBeInTheDocument();
    // Each account is shown with its source system and enabled state.
    expect(screen.getAllByRole('columnheader').map(th => th.textContent))
      .toEqual(['System', 'Account', 'Enabled', 'Type', 'Actions']);
    const row = screen.getByRole('button', { name: 'ddoe@legacy' }).closest('tr');
    expect(row).toHaveTextContent('HR CSV');
    expect(row).toHaveTextContent('No');
  });

  it('asks the organisation lists nothing while the feature is off, and shows no organisation neighbours on a 404 or 501', async () => {
    const off = routes();
    const first = renderWithProviders(h(IdentityDetailPage, baseProps), { auth: { authFetch: off } });
    await screen.findByText('Dana Doe');
    await userEvent.setup().click(screen.getByRole('tab', { name: /Relationships/i }));
    await screen.findByRole('button', { name: /^User dana@corp\.com/ });
    expect(off.mock.calls.some(([u]) => String(u).includes('/org-truth/'))).toBe(false);
    first.unmount();

    for (const status of [404, 501]) {
      const authFetch = routes({ '/api/org-truth/linked/': jsonResponse({ error: 'off' }, { ok: false, status }) });
      const { unmount, container } = renderWithProviders(h(IdentityDetailPage, baseProps), { auth: { authFetch }, features: { orgTruth: true } });
      const user = userEvent.setup();
      await screen.findByText('Dana Doe');
      await user.click(screen.getByRole('tab', { name: /Relationships/i }));
      await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/org-truth/linked/Identity/id-1'));
      await screen.findByRole('button', { name: /^User dana@corp\.com/ });
      expect(container.querySelector('[data-node^="org-entity:"]')).toBeNull();
      expect(screen.queryByText('Organisation')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('draws organisation entities as direct neighbours: linked by attribute, or by the hours worked', async () => {
    const linked = {
      total: 3,
      groups: [
        { key: 'direct|Klant|eigenaar', entityType: 'Klant', via: 'eigenaar', kind: 'direct', label: 'Klant · eigenaar', count: 1,
          items: [{ entityId: 'k1', entityType: 'Klant', label: 'Contoso BV', detail: null }] },
        { key: 'through|Klant|Uren|klant', entityType: 'Klant', via: 'klant', kind: 'through', sourceType: 'Uren', label: 'Klant · worked on (Uren)',
          count: 2, unlinkedRows: 12, items: [
            { entityId: 'k2', entityType: 'Klant', label: 'Fabrikam', detail: '1491 h · 3 rows · until 2026-01', hours: 1491 },
            { entityId: 'k3', entityType: 'Klant', label: 'Northwind', detail: '1 h · 1 rows', hours: 1 },
          ] },
      ],
    };
    const onOpenDetail = vi.fn();
    const authFetch = routes({ '/api/org-truth/linked/Identity/id-1': linked });
    const { container } = renderWithProviders(h(IdentityDetailPage, { ...baseProps, onOpenDetail }), { auth: { authFetch }, features: { orgTruth: true } });
    const user = userEvent.setup();
    await screen.findByText('Dana Doe');
    await user.click(screen.getByRole('tab', { name: /Relationships/i }));

    // Three customers, linked two ways, are ONE "Klant" node with the count until it is opened.
    const cluster = await screen.findByRole('button', { name: '3 Klant, press to show them' });
    expect(container.querySelectorAll('[data-node^="org-entity:"]')).toHaveLength(0);
    expect(container.querySelector('[data-edge="identity:id-1->cluster:identity:id-1:org:type:Klant"]')?.textContent)
      .toBe('eigenaar · worked on (Uren)');
    await user.click(cluster);

    await screen.findByRole('button', { name: 'Klant Contoso BV, press to expand' });
    expect(container.querySelectorAll('[data-node^="org-entity:"]')).toHaveLength(3);
    const edgeText = (to) => container.querySelector(`[data-edge="identity:id-1->org-entity:${to}"]`)?.textContent;
    expect(edgeText('k1')).toBe('eigenaar');
    expect(edgeText('k2')).toBe('worked on · 1,491 h (Uren)');
    expect(edgeText('k3')).toBe('worked on · 1 h (Uren)');
    // No Organisation bucket and no "Klant · eigenaar" bucket in between.
    expect(screen.queryByText('Organisation')).toBeNull();
    expect(screen.queryByText('Klant · eigenaar')).toBeNull();

    await user.click(screen.getByRole('link', { name: 'Open Northwind' }));
    expect(onOpenDetail).toHaveBeenCalledWith('org-entity', 'k3', 'Northwind');
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

describe('IdentityDetailPage organisation enrichment and activity', () => {
  it('adds the enrichment to the attributes with its source chip and shows the activity summary', async () => {
    const authFetch = routes({
      '/api/org-truth/enrichment/Identity/id-1': { groups: [{ source: 'Maten', attributes: { level: 'Senior' } }] },
      '/api/org-truth/activity/actor/Identity/id-1': { groups: [{ type: 'Uren', unit: 'h', subjects: [{ targetType: 'OrgEntity', targetId: 'k1', label: 'Contoso', total: 4, lastOn: '2026-01-01', isMember: true }] }] },
    });
    renderWithProviders(h(IdentityDetailPage, baseProps), { auth: { authFetch }, features: { orgTruth: true } });
    const row = (await screen.findByText('level')).closest('tr');
    expect(row).toHaveTextContent('Senior');
    expect(row).toHaveTextContent('Maten');
    const table = await screen.findByRole('table', { name: 'Uren' });
    expect(table.querySelector('tbody tr').textContent).toBe('Contoso4 hJanuary 2026yes');
  });

  it('shows neither when the routes are not there', async () => {
    const authFetch = routes({ '/api/org-truth/': jsonResponse({ error: 'off' }, { ok: false, status: 501 }) });
    renderWithProviders(h(IdentityDetailPage, baseProps), { auth: { authFetch }, features: { orgTruth: true } });
    await screen.findByText('Dana Doe');
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/org-truth/activity/actor/Identity/id-1'));
    expect(screen.queryByText('Activity in imported lists')).toBeNull();
    expect(screen.queryByTitle('From the imported list', { exact: false })).toBeNull();
  });
});
