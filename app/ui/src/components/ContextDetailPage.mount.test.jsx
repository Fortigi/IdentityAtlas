// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement as h, useState } from 'react';
import ContextDetailPage from './ContextDetailPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, fireEvent, waitFor, userEvent, within } from '@ui/test-utils/renderWithProviders';

// useFeatures uses the global `fetch` (not authFetch) to hit /api/features.
// Stub it so the riskScoring flag is available and predictable.
beforeEach(() => { global.fetch = vi.fn(async () => jsonResponse({ riskScoring: true, accountLinking: true })); });
afterEach(() => { vi.restoreAllMocks(); });

// A loaded "generated" context with a couple of members + a sub-context.
const generatedDetail = {
  attributes: {
    id: 'ctx-1', variant: 'generated', targetType: 'Identity', contextType: 'Cluster',
    displayName: 'Engineering Cluster', description: 'A generated cluster of engineers.',
    scopeSystemName: 'EntraID', sourceAlgorithmName: 'kmeans', sourceAlgorithmDisplayName: 'K-Means Clustering',
    directMemberCount: 2, totalMemberCount: 5,
    department: 'Engineering', confidence: 0.92, // surface under More details
  },
  subContexts: [{ id: 'ctx-child', displayName: 'Backend Squad', memberCount: 3 }],
};

const members = {
  total: 2,
  data: [
    { id: 'm-1', displayName: 'Alice Engineer', email: 'alice@example.com', jobTitle: 'Staff Engineer', principalType: 'User', accountEnabled: true, addedBy: 'algorithm' },
    { id: 'm-2', displayName: 'Bob Builder', email: 'bob@example.com', jobTitle: 'Engineer', principalType: 'User', accountEnabled: false, addedBy: 'analyst' },
  ],
};

const timeline = { events: [], addedCount: 0, removedCount: 0, changedCount: 0, sinceDays: 90 };

const riskData = {
  riskScore: 70, riskTier: 'High', riskScoredAt: '2026-06-01T10:00:00Z',
  riskDirectScore: 30, riskMembershipScore: 20, riskStructuralScore: 10, riskPropagatedScore: 10,
};

// Order matters: more-specific substrings (/members, /timeline) before the
// bare /api/contexts/ctx-1 detail key.
function routes(overrides = {}) {
  return makeAuthFetch({
    '/api/risk-scores/contexts/ctx-1': riskData,
    '/api/contexts/ctx-1/members': members,
    '/api/contexts/ctx-1/timeline': timeline,
    '/api/contexts/ctx-1': generatedDetail,
    ...overrides,
  });
}

const baseProps = {
  contextId: 'ctx-1',
  cachedData: null,
  onCacheData: () => {},
  onClose: () => {},
  onOpenDetail: () => {},
};

// Opens the header's ⋯ menu and returns the item named `name` (or null).
async function menuItem(user, name) {
  await user.click(await screen.findByRole('button', { name: 'More actions' }));
  return screen.queryByRole('menuitem', { name });
}

const PEOPLE_EMPTY = { data: [], total: 0, counts: { current: 0, former: 0, all: 0, decide: 0 }, linkedResources: 0 };

describe('ContextDetailPage — no owner chip; who answers for it is the Accountable', () => {
  // Both cases come from real data shapes: owners that resolve, and owners that
  // are employee numbers no principal is keyed on.
  const unitWithOwner = (owner, roles = []) => makeAuthFetch({
    '/api/contexts/ctx-1/people': PEOPLE_EMPTY,
    '/api/contexts/ctx-1/roles': roles,
    '/api/risk-scores/contexts/ctx-1': riskData,
    '/api/contexts/ctx-1': { ...generatedDetail, attributes: { ...generatedDetail.attributes, contextCategory: 'OrganizationalUnit', targetType: 'Principal', ...owner } },
  });

  it('shows no "Owner:" chip for a resolved owner: the Accountable carries the name', async () => {
    const authFetch = unitWithOwner({ ownerUserId: 'IIQ-4711', ownerPrincipalId: 'p-owner', ownerDisplayName: 'Leo Example' },
      [{ id: 'r1', role: 'Accountable', principalId: 'p-owner', identityId: null, displayName: 'Leo Example', addedBy: 'sync' }]);
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    expect(await screen.findByRole('button', { name: 'Leo Example' })).toBeInTheDocument();
    expect(screen.queryByText(/Owner:/)).toBeNull();
    expect(screen.queryByTitle('Owner id: IIQ-4711')).toBeNull();
    expect(screen.queryByTestId('unmatched-owner')).toBeNull();
  });

  it('says the source names an owner nobody matches, while no Accountable is set', async () => {
    const authFetch = unitWithOwner({ ownerUserId: '10000737', ownerPrincipalId: null, ownerDisplayName: null });
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    expect(await screen.findByTestId('unmatched-owner')).toHaveTextContent('The source names “10000737” as the owner; no account found.');
    expect(screen.queryByText(/Owner:/)).toBeNull();
  });
});

describe('ContextDetailPage — the template in the header', () => {
  it('shows no classification badges and asks a context without a template for no roles', async () => {
    const authFetch = routes();
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    await screen.findByText('Engineering Cluster');
    for (const badge of ['Other', 'Identity', 'Generated', 'CLUSTER']) expect(screen.queryByText(badge)).toBeNull();
    expect(screen.queryByText('People')).toBeNull();
    expect(authFetch).not.toHaveBeenCalledWith(expect.stringContaining('/roles'));
  });

  it('keeps the generic page for a tag or segment: no profile, no variants, no workflows', async () => {
    for (const contextCategory of ['Tag', 'Segment']) {
      const authFetch = routes({ '/api/contexts/ctx-1': { ...generatedDetail, attributes: { ...generatedDetail.attributes, contextCategory } } });
      const { unmount } = renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
      expect(await screen.findByText('Engineering Cluster')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: /^About this/ })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Actions' })).toBeNull();
      expect(authFetch).not.toHaveBeenCalledWith(expect.stringContaining('/relationships'));
      unmount();
    }
  });

  it('gives an application its sections: Download report, its resources, What we know — no Actions grid', async () => {
    const authFetch = makeAuthFetch({
      '/api/contexts/ctx-1/people': PEOPLE_EMPTY,
      '/api/contexts/ctx-1/members': { total: 1, data: [{ id: 'r-1', displayName: 'SG-Ledger', resourceType: 'Group' }] },
      '/api/risk-scores/contexts/ctx-1': riskData,
      '/api/contexts/ctx-1': { ...generatedDetail, attributes: { ...generatedDetail.attributes, contextCategory: 'LogicalApplication', targetType: 'Resource' } },
    });
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    expect(await screen.findByRole('button', { name: 'Download report' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Resources' })).toHaveTextContent('SG-Ledger');
    expect(screen.getByRole('region', { name: 'What we know' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Actions' })).toBeNull();
    // An application's members are resources: its People section waits for a source to name someone.
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('/api/contexts/ctx-1/people?filter=current')));
    expect(screen.queryByRole('region', { name: 'People' })).toBeNull();
  });

  it('lists the people answering for an organisational unit under its name, in the header', async () => {
    // The roles key must sit before the bare detail key (substring match), so
    // it cannot go through routes()' overrides spread.
    const authFetch = makeAuthFetch({
      '/api/contexts/ctx-1/roles': [{ id: 'r1', role: 'Accountable', principalId: 'p-1', identityId: null, displayName: 'Mara Example', addedBy: 'algorithm' }],
      '/api/contexts/ctx-1/people': PEOPLE_EMPTY,
      '/api/risk-scores/contexts/ctx-1': riskData,
      '/api/contexts/ctx-1/timeline': timeline,
      '/api/contexts/ctx-1': { ...generatedDetail, attributes: { ...generatedDetail.attributes, contextCategory: 'OrganizationalUnit' } },
    });
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    const block = await screen.findByTestId('context-people');
    await waitFor(() => expect(within(block).getByRole('group', { name: 'Accountable' })).toHaveTextContent('Mara Example'));
    // The header holds it: the same card as the name.
    expect(block.closest('.rounded-lg')).toHaveTextContent('Engineering Cluster');
    // A unit of people reads its people, not the members list.
    expect(authFetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/contexts/ctx-1/members'));
  });
});

describe('ContextDetailPage — Authorization workbench', () => {
  const unit = (category) => makeAuthFetch({
    '/api/contexts/ctx-1/roles': [],
    '/api/contexts/ctx-1/people': PEOPLE_EMPTY,
    '/api/risk-scores/contexts/ctx-1': riskData,
    '/api/contexts/ctx-1/timeline': timeline,
    '/api/contexts/ctx-1/members': members,
    '/api/contexts/ctx-1': { ...generatedDetail, attributes: { ...generatedDetail.attributes, contextCategory: category } },
  });

  it('opens an organizational unit’s workbench as its own tab', async () => {
    const user = userEvent.setup();
    const onOpenDetail = vi.fn();
    renderWithProviders(h(ContextDetailPage, { ...baseProps, onOpenDetail }), { auth: { authFetch: unit('OrganizationalUnit') }, features: { orgKnowledge: true } });
    await user.click(await screen.findByRole('button', { name: 'Authorization workbench' }));
    expect(onOpenDetail).toHaveBeenCalledWith('workbench', 'ctx-1', 'Workbench: Engineering Cluster');
  });

  it('offers no workbench on an application', async () => {
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch: unit('LogicalApplication') }, features: { orgKnowledge: true } });
    expect(await screen.findByText('Engineering Cluster')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Authorization workbench' })).toBeNull();
  });

  it('offers no workbench while organisation knowledge is off', async () => {
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch: unit('OrganizationalUnit') } });
    expect(await screen.findByText('Engineering Cluster')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Authorization workbench' })).toBeNull();
  });
});
describe('ContextDetailPage (mounted)', () => {
  it('shows the loading state before the detail fetch resolves', () => {
    // authFetch that never resolves keeps it in the loading branch.
    const authFetch = vi.fn(() => new Promise(() => {}));
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    expect(screen.getByText(/Loading context details/i)).toBeInTheDocument();
  });

  it('renders the header, the subtitle sentence and members after load', async () => {
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch: routes() } });

    // Header: the name and one sentence, no internal words.
    expect(await screen.findByText('Engineering Cluster')).toBeInTheDocument();
    expect(screen.getByTestId('context-subtitle')).toHaveTextContent(/^Cluster · derived by the K-Means Clustering rule$/);
    expect(document.body.textContent).not.toMatch(/plugin|crawl|analyst|Sub-contexts|Relationships/);
    // Description card
    expect(screen.getByText('A generated cluster of engineers.')).toBeInTheDocument();

    // Default tab is "relationships" — sub-contexts + members render.
    expect(await screen.findByText('Sub-units (1)')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Sub-units' })).toHaveTextContent('3 people');
    expect(screen.getByText('Backend Squad')).toBeInTheDocument();
    expect(await screen.findByText('Alice Engineer')).toBeInTheDocument();
    expect(screen.getByText('Bob Builder')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('Staff Engineer')).toBeInTheDocument();
    // A people context has no account status column.
    expect(screen.queryByText('Active')).toBeNull();
  });

  it('shows an account member\'s type and status', async () => {
    const authFetch = routes({
      '/api/contexts/ctx-1': { ...generatedDetail, attributes: { ...generatedDetail.attributes, targetType: 'Principal' } },
    });
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    const alice = (await screen.findByText('Alice Engineer')).closest('tr');
    expect([...alice.cells].map(c => c.textContent).slice(0, 5)).toEqual(['Alice Engineer', 'alice@example.com', 'Staff Engineer', 'Member', 'Active']);
    expect(screen.getByText('Bob Builder').closest('tr')).toHaveTextContent('Disabled');
  });

  it('has no Attributes tab and shows each remaining attribute once, under More details', async () => {
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch: routes() } });
    await screen.findByText('Engineering Cluster');
    expect(screen.queryByRole('tab')).toBeNull();
    // No tabs: the Timeline and Risk fold at the foot of the page, in that order.
    const folds = ['Timeline', 'Risk'].map(name => screen.getByRole('region', { name }));
    expect(folds[0].compareDocumentPosition(folds[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const details = screen.getByRole('region', { name: 'More details' });
    // The analyst's list (with the raw classification) is long, so it starts folded.
    await userEvent.setup().click(within(details).getByRole('button', { name: /More details/ }));
    expect(within(details).getByText('Department').nextElementSibling).toHaveTextContent('Engineering');
    expect(within(details).getByText('Confidence').nextElementSibling).toHaveTextContent('0.92');
    // A context without a profile has no member fact, so both counts are here.
    expect(within(details).getByText('Total Member Count').nextElementSibling).toHaveTextContent('5');
    // What the header or the description card already shows is not repeated.
    for (const shown of ['EntraID', 'A generated cluster of engineers.', 'Engineering']) {
      expect(screen.getAllByText(shown)).toHaveLength(1);
    }
    for (const key of ['Display Name', 'Description', 'Source Algorithm Display Name']) {
      expect(within(details).queryByText(key)).toBeNull();
    }
    // The analyst sees the raw classification behind the subtitle.
    expect(within(details).getByText('Variant').nextElementSibling).toHaveTextContent('generated');
    expect(within(details).getByText('Source Algorithm Name').nextElementSibling).toHaveTextContent('kmeans');
  });

  it('folds a long details list until it is opened', async () => {
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['field' + i, 'v' + i]));
    const authFetch = routes({ '/api/contexts/ctx-1': { ...generatedDetail, attributes: { ...generatedDetail.attributes, ...many } } });
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    const toggle = await screen.findByRole('button', { name: /More details/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Field0')).toBeNull();
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Field0').nextElementSibling).toHaveTextContent('v0');
  });

  it('Edit opens the editor in a modal; a save refreshes the page', async () => {
    const authFetch = routes();
    const onEdited = vi.fn();
    renderWithProviders(h(ContextDetailPage, { ...baseProps, onEdited }), { auth: { authFetch } });
    const user = userEvent.setup();
    await user.click(await menuItem(user, 'Edit'));
    expect(screen.getByRole('heading', { name: 'Edit Engineering Cluster' })).toBeInTheDocument();
    expect(screen.queryByText(/Generated context/)).toBeNull();

    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Platform Cluster');
    const detailReads = () => authFetch.mock.calls.filter(([u, o]) => u === '/api/contexts/ctx-1' && !o?.method).length;
    const before = detailReads();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1', expect.objectContaining({ method: 'PATCH' }));
    await waitFor(() => expect(detailReads()).toBe(before + 1));
    expect(onEdited).toHaveBeenCalled();
    await screen.findByText('Engineering Cluster');
    expect(screen.queryByRole('heading', { name: 'Edit Engineering Cluster' })).toBeNull();
  });

  it('the one delete in the Edit modal deletes after its confirm and closes the page', async () => {
    const authFetch = routes();
    const onClose = vi.fn();
    renderWithProviders(h(ContextDetailPage, { ...baseProps, onClose }), { auth: { authFetch } });
    const user = userEvent.setup();
    await user.click(await menuItem(user, 'Edit'));
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(await screen.findByText(/the next refresh creates it again/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(authFetch).toHaveBeenCalledWith('/api/contexts/ctx-1', expect.objectContaining({ method: 'DELETE' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('the modal close button leaves the context untouched', async () => {
    const authFetch = routes();
    renderWithProviders(h(ContextDetailPage, { ...baseProps, embedded: true }), { auth: { authFetch } });
    const user = userEvent.setup();
    await user.click(await menuItem(user, 'Edit'));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: 'Edit Engineering Cluster' })).toBeNull();
    expect(authFetch).not.toHaveBeenCalledWith('/api/contexts/ctx-1', expect.objectContaining({ method: 'PATCH' }));
  });

  it('offers no Edit for a synced context, nor to a reader', async () => {
    const synced = routes({ '/api/contexts/ctx-1': { ...generatedDetail, attributes: { ...generatedDetail.attributes, variant: 'synced' } } });
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch: synced } });
    expect(await menuItem(user, 'Edit')).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toBeInTheDocument();
    unmount();
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch: routes(), hasWildcard: false, permissions: new Set(['data.read']) } });
    expect(await menuItem(user, 'Edit')).toBeNull();
    // A reader gets neither the Timeline nor the Risk.
    expect(screen.queryByRole('region', { name: 'Timeline' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Risk' })).toBeNull();
  });

  it('reads the timeline only once its fold is opened', async () => {
    const authFetch = routes();
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    const user = userEvent.setup();

    const fold = await screen.findByRole('region', { name: 'Timeline' });
    expect(authFetch).not.toHaveBeenCalledWith(expect.stringContaining('/timeline'));
    await user.click(within(fold).getByRole('button', { name: /Timeline/ }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('/api/contexts/ctx-1/timeline')));
  });

  it('folds the Risk score at the foot when risk data + feature flag are present, with its tier', async () => {
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch: routes() } });
    const user = userEvent.setup();

    const fold = await screen.findByRole('region', { name: 'Risk' });
    expect(within(fold).getByTestId('risk-summary')).toHaveTextContent('High · 70');
    expect(screen.queryByText('Risk Assessment')).toBeNull();
    await user.click(within(fold).getByRole('button', { name: /Risk/ }));
    expect(await screen.findByText('Risk Assessment')).toBeInTheDocument();
  });

  it('shows no Risk fold without a score', async () => {
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch: routes({ '/api/risk-scores/contexts/ctx-1': { riskScore: null } }) } });
    await screen.findByRole('region', { name: 'Timeline' });
    expect(screen.queryByRole('region', { name: 'Risk' })).toBeNull();
  });

  it('filters members via the search box', async () => {
    const authFetch = routes();
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });

    await screen.findByText('Alice Engineer');
    fireEvent.change(screen.getByLabelText('Search members'), {
      target: { value: 'alice' },
    });

    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringContaining('search=alice'),
      ),
    );
  });

  it('toggles include-sub-contexts which re-queries with the descendants param', async () => {
    const authFetch = routes();
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });

    await screen.findByText('Alice Engineer');
    fireEvent.click(screen.getByLabelText('Include sub-units'));

    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringContaining('include=descendants'),
      ),
    );
  });

  it('opens a sub-context via onOpenDetail when clicked', async () => {
    const onOpenDetail = vi.fn();
    renderWithProviders(
      h(ContextDetailPage, { ...baseProps, onOpenDetail }),
      { auth: { authFetch: routes() } },
    );
    const user = userEvent.setup();

    await user.click(await screen.findByText('Backend Squad'));
    expect(onOpenDetail).toHaveBeenCalledWith('context', 'ctx-child', 'Backend Squad');
  });

  it('wraps the members table in a horizontally-scrolling container', async () => {
    const { container } = renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch: routes() } });

    await screen.findByText('Alice Engineer');
    const wrapper = container.querySelector('table').closest('.overflow-x-auto');
    expect(wrapper).toBeTruthy();
  });

  it('shows a person member\'s email, job title and department', async () => {
    const authFetch = routes({
      '/api/contexts/ctx-1/members': { total: 1, data: [
        { id: 'm-1', displayName: 'Alice Engineer', email: 'alice@example.com', jobTitle: 'Staff Engineer', department: 'R&D' },
      ] },
    });
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    const row = (await screen.findByText('Alice Engineer')).closest('tr');
    expect([...row.cells].map(c => c.textContent).slice(0, 4)).toEqual(['Alice Engineer', 'alice@example.com', 'Staff Engineer', 'R&D']);
    const headers = [...row.closest('table').querySelectorAll('th')].map(t => t.textContent);
    expect(headers.slice(0, 4)).toEqual(['Name', 'Email', 'Job title', 'Department']);
  });

  it('shows a resource member\'s type, description and status instead of person columns', async () => {
    const authFetch = routes({
      '/api/contexts/ctx-1': { ...generatedDetail, attributes: { ...generatedDetail.attributes, targetType: 'Resource' } },
      '/api/contexts/ctx-1/members': { total: 1, data: [
        { id: 'r-1', displayName: 'SG-Finance', resourceType: 'Group', description: 'Finance team', enabled: false },
      ] },
    });
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    const row = (await screen.findByText('SG-Finance')).closest('tr');
    expect([...row.cells].map(c => c.textContent).slice(0, 4)).toEqual(['SG-Finance', 'Group', 'Finance team', 'Disabled']);
    const headers = [...row.closest('table').querySelectorAll('th')].map(t => t.textContent);
    expect(headers).not.toContain('Email');
    // A page whose rows carry no holder count or owner shows neither column.
    expect(headers).not.toContain('Users');
    expect(headers).not.toContain('Owner');
  });

  it('shows how many users hold a resource member and who owns it, the owner\'s e-mail as its tooltip', async () => {
    const authFetch = routes({
      '/api/contexts/ctx-1': { ...generatedDetail, attributes: { ...generatedDetail.attributes, targetType: 'Resource' } },
      '/api/contexts/ctx-1/members': { total: 2, data: [
        { id: 'r-1', displayName: 'ENT_LEDGER', resourceType: 'Entitlement', holderCount: 45210, ownerDisplayName: 'Grace Hopper', ownerEmail: 'grace@example.com', ownerPrincipalId: 'p-grace' },
        { id: 'r-2', displayName: 'ENT_QUIET', resourceType: 'Entitlement', holderCount: 0, ownerDisplayName: null, ownerEmail: null },
        { id: 'r-3', displayName: 'ENT_NAMED', resourceType: 'Entitlement', holderCount: 2, ownerDisplayName: 'Only In Source', ownerEmail: null, ownerPrincipalId: null },
      ] },
    });
    const onOpenDetail = vi.fn();
    renderWithProviders(h(ContextDetailPage, { ...baseProps, onOpenDetail }), { auth: { authFetch } });
    const row = (await screen.findByText('ENT_LEDGER')).closest('tr');
    const headers = [...row.closest('table').querySelectorAll('th')];
    // Owner before Users, so the left-aligned name and the right-aligned count don't touch.
    expect(headers.map(t => t.textContent).slice(0, 4)).toEqual(['Name', 'Type', 'Owner', 'Users']);
    expect(headers[3].className).toContain('text-right');
    expect([...row.cells].map(c => c.textContent).slice(0, 4)).toEqual(['ENT_LEDGER', 'Entitlement', 'Grace Hopper', '45,210']);
    expect(row.cells[3].className).toContain('sm:text-right');
    // A resolved owner is a link to the account, without also opening the resource.
    const owner = screen.getByRole('button', { name: 'Grace Hopper' });
    expect(owner).toHaveAttribute('title', 'grace@example.com');
    await userEvent.setup().click(owner);
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p-grace', 'Grace Hopper');
    // An owner only the source named has no account: plain text.
    expect(screen.queryByRole('button', { name: 'Only In Source' })).toBeNull();
    expect(screen.getByText('Only In Source')).toBeInTheDocument();
    // Nobody holds it: a 0, not a blank; nobody owns it: an empty cell.
    const quiet = screen.getByText('ENT_QUIET').closest('tr');
    expect([...quiet.cells].map(c => c.textContent).slice(2, 4)).toEqual(['', '0']);
  });

  it('renders the empty members state', async () => {
    const authFetch = routes({
      '/api/contexts/ctx-1/members': { total: 0, data: [] },
    });
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });

    expect(await screen.findByText('No members found.')).toBeInTheDocument();
  });

  it('renders the error state and retries on click', async () => {
    let calls = 0;
    const authFetch = vi.fn(async (url, opts = {}) => {
      if (String(url).includes('/api/contexts/ctx-1') &&
          !url.includes('/members') && !url.includes('/timeline')) {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: 'boom' }, { ok: false, status: 500 });
        return jsonResponse(generatedDetail);
      }
      if (url.includes('/members')) return jsonResponse(members);
      if (url.includes('/timeline')) return jsonResponse(timeline);
      if (url.includes('/risk-scores')) return jsonResponse(riskData);
      return jsonResponse({}, { ok: false, status: 404 });
    });

    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    const user = userEvent.setup();

    expect(await screen.findByText('Failed to load context')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();

    await user.click(screen.getByText('Retry'));
    // Second fetch succeeds → header renders.
    expect(await screen.findByText('Engineering Cluster')).toBeInTheDocument();
  });

  it('caches the loaded detail via onCacheData', async () => {
    const onCacheData = vi.fn();
    renderWithProviders(
      h(ContextDetailPage, { ...baseProps, onCacheData }),
      { auth: { authFetch: routes() } },
    );

    await screen.findByText('Engineering Cluster');
    expect(onCacheData).toHaveBeenCalledWith('ctx-1', 'context', generatedDetail);
  });
});

describe('ContextDetailPage — embedded in the Contexts page', () => {
  it('has no close button but an "Open as page" button that hands over the context', async () => {
    const onOpenAsPage = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      h(ContextDetailPage, { ...baseProps, embedded: true, onOpenAsPage, onClose }),
      { auth: { authFetch: routes() } },
    );
    await screen.findByText('Engineering Cluster');
    expect(screen.queryByTitle('Close')).toBeNull();
    const user = userEvent.setup();
    expect(await menuItem(user, 'Back to Contexts')).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Open as page' }));
    expect(onOpenAsPage).toHaveBeenCalledWith(expect.objectContaining({ id: 'ctx-1', displayName: 'Engineering Cluster' }));
    expect(onClose).not.toHaveBeenCalled();
    // The menu closed behind the choice.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('as a page gives the analyst "Back to Contexts" and offers no "Open as page"', async () => {
    const onClose = vi.fn();
    renderWithProviders(h(ContextDetailPage, { ...baseProps, onClose, onOpenAsPage: vi.fn() }), { auth: { authFetch: routes() } });
    const user = userEvent.setup();
    expect(await menuItem(user, 'Open as page')).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Back to Contexts' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows "Context not found" without a Close link when embedded, with one as a page', async () => {
    const authFetch = routes({ '/api/contexts/ctx-1': { attributes: null } });
    const { unmount } = renderWithProviders(h(ContextDetailPage, { ...baseProps, embedded: true }), { auth: { authFetch } });
    expect(await screen.findByText(/Context not found/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    unmount();
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    expect(await screen.findByText(/Context not found/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('re-reads the context and its members when refreshKey changes', async () => {
    const authFetch = routes();
    const onEdited = vi.fn();
    // The page around it bumps refreshKey after a tree edit.
    function Harness() {
      const [key, setKey] = useState(0);
      return h('div', null,
        h('button', { onClick: () => setKey(k => k + 1) }, 'bump'),
        h(ContextDetailPage, { ...baseProps, embedded: true, refreshKey: key, onEdited }));
    }
    renderWithProviders(h(Harness), { auth: { authFetch } });
    await screen.findByText('Engineering Cluster');
    const detailReads = () => authFetch.mock.calls.filter(([u]) => u === '/api/contexts/ctx-1').length;
    const memberReads = () => authFetch.mock.calls.filter(([u]) => String(u).startsWith('/api/contexts/ctx-1/members')).length;
    const [detailBefore, membersBefore] = [detailReads(), memberReads()];
    fireEvent.click(screen.getByRole('button', { name: 'bump' }));
    await waitFor(() => expect(detailReads()).toBe(detailBefore + 1));
    expect(memberReads()).toBe(membersBefore + 1);
    expect(await screen.findByText('Engineering Cluster')).toBeInTheDocument();
    expect(onEdited).not.toHaveBeenCalled(); // a refresh from outside is not an edit here
  });
});

describe('ContextDetailPage — a unit of an uploaded list', () => {
  const uploaded = {
    attributes: {
      id: 'ctx-1', variant: 'synced', targetType: 'Principal', contextType: 'OrgUnit', contextCategory: 'OrganizationalUnit',
      displayName: 'Acme', scopeSystemId: 42, scopeSystemName: 'Klanten (upload)', scopeSystemType: 'Upload',
      createdAt: '2026-10-01T10:00:00.000Z',
      uploadedFrom: 'klanten.xlsx', uploadedAt: '2026-10-01T10:00:00.000Z', uploadedBy: 'analyst@example.com',
      lastUploadFile: 'klanten-v2.xlsx', lastUploadAt: '2026-10-20T10:00:00.000Z', lastUploadBy: 'analyst@example.com',
    },
    subContexts: [],
  };

  it('says under its header that it came from an upload, when, by whom, and when it was last updated', async () => {
    const authFetch = routes({ '/api/contexts/ctx-1': uploaded });
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch } });
    const line = await screen.findByTestId('upload-provenance');
    expect(line.textContent).toMatch(/^Uploaded from klanten\.xlsx on .+ by analyst@example\.com; last updated by an upload of klanten-v2\.xlsx on .+\. This unit exists since .+\.$/);
  });

  it('says nothing about uploads for a context from anywhere else', async () => {
    renderWithProviders(h(ContextDetailPage, baseProps), { auth: { authFetch: routes() } });
    await screen.findByText('Engineering Cluster');
    expect(screen.queryByTestId('upload-provenance')).toBeNull();
  });
});
