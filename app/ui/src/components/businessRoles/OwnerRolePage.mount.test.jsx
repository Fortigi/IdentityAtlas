// @vitest-environment jsdom
//
// A context owner who also answers for business roles: those roles on the Role
// portfolios tab of their own page, filed under the portfolio each sits in (light,
// when they do not hold it) or under "Default portfolio", and the Composition
// review they may sign off there.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ContextOwnerPage from '@ui/components/ContextOwnerPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

const UNIT = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROLE = 'bbbbbbbb-0000-4000-8000-000000000001';
const SECOND = 'bbbbbbbb-0000-4000-8000-000000000002';
const PORTFOLIO = 'cccccccc-0000-4000-8000-000000000001';
const HELD_PORTFOLIO = 'cccccccc-0000-4000-8000-000000000002';
const THIRD = 'bbbbbbbb-0000-4000-8000-000000000003';
const ROLES = [
  { id: ROLE, displayName: 'Finance controller', role: 'Accountable', portfolioId: PORTFOLIO, portfolioName: 'Finance roles' },
  { id: SECOND, displayName: 'Payroll clerk', role: 'Responsible', portfolioId: null, portfolioName: null },
];

const roleBody = (id, displayName) => ({
  attributes: { id, displayName },
  accessModel: { waysIn: ['Request'], waysOut: ['Review'], control: 'Manual', reviewRequired: true, reviewGap: false },
  assignmentCount: 3, groupCount: 1,
});

const ROOT = { id: UNIT, displayName: 'Finance', contextCategory: 'OrganizationalUnit', targetType: 'Identity', variant: 'manual', contextType: 'Department', totalMemberCount: 1, directMemberCount: 1, children: [] };

function api({ canReview = true, tree = [ROOT] } = {}) {
  const posts = [];
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/api/context-owner/tree')) return tree;
    if (u.includes('/api/risk-scores/')) return jsonResponse(null, { ok: false, status: 404 });
    if (u.endsWith('/composition-reviews')) {
      if (opts.method === 'POST') { posts.push([u, JSON.parse(opts.body)]); return jsonResponse({ id: 'new' }, { status: 201 }); }
      return { reviews: [], current: { type: { control: 'Manual' }, resources: [{ id: 'g1' }] }, latestSignOff: null, canReview };
    }
    if (u.endsWith(`/api/access-package/${ROLE}`)) return roleBody(ROLE, 'Finance controller');
    if (u.endsWith(`/api/access-package/${SECOND}`)) return roleBody(SECOND, 'Payroll clerk');
    if (/\/api\/access-package\/[^/]+\/(owners|participants|policies|assignments|resource-roles|reviews|requests)/.test(u)) return [];
    if (u.endsWith(`/api/contexts/${UNIT}`)) {
      return { attributes: { id: UNIT, displayName: 'Finance', variant: 'manual', targetType: 'Identity', contextType: 'Department', contextCategory: 'OrganizationalUnit' }, subContexts: [] };
    }
    if (u.includes('/api/contexts/')) return [];
    return undefined;
  });
  return { authFetch, posts };
}

const HELD_UNIT = { id: UNIT, displayName: 'Finance', role: 'Accountable', contextCategory: 'OrganizationalUnit', targetType: 'Identity' };

function mount({ businessRoles = ROLES, flags = { compositionReview: true }, contextIds = [UNIT], contexts = [HELD_UNIT], ...opts } = {}) {
  global.fetch = vi.fn(async (u) => jsonResponse(String(u).includes('/api/features') ? flags : {}));
  const { authFetch, posts } = api(opts);
  renderWithProviders(<ContextOwnerPage />, {
    auth: {
      authFetch, authEnabled: true, hasWildcard: false, permissions: new Set(),
      account: { name: 'Carla Cash' },
      contextOwner: { contexts, contextIds, businessRoles },
    },
  });
  return { authFetch, posts, user: userEvent.setup() };
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.restoreAllMocks());

const portfolioTab = () => screen.findByRole('tab', { name: 'Role portfolios' });
const nav = () => within(screen.getByRole('navigation', { name: 'What you answer for' }));

describe('Business roles on Role portfolios', () => {
  it('offers no Role portfolios tab to an owner who answers for no business role', async () => {
    mount({ businessRoles: [] });
    await screen.findAllByText('Finance');
    expect(screen.queryByRole('tab', { name: 'Role portfolios' })).toBeNull();
  });

  it('puts Role portfolios on the same row as Organisation, and no Business roles tab', async () => {
    mount();
    const org = await screen.findByRole('tab', { name: 'Organisation' });
    expect(org).toHaveAttribute('aria-selected', 'true');
    expect(within(org.parentElement).getAllByRole('tab').map(t => t.textContent)).toEqual(['Organisation', 'Role portfolios']);
    expect(screen.queryByRole('tab', { name: 'Business roles' })).toBeNull();
    expect(screen.queryByText(/contexts/i)).toBeNull();
  });

  it('offers "Your units" beside Role portfolios when the tree cannot load', async () => {
    const { user } = mount({ tree: [] });
    expect(await screen.findByRole('tab', { name: 'Your units' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Role portfolios' }));
    expect(await screen.findByRole('tab', { name: 'Composition review' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Role portfolios' })).toHaveAttribute('aria-selected', 'true');
    expect(nav().getByRole('button', { name: /Finance controller/ })).toHaveAttribute('aria-current', 'true');
    await user.click(screen.getByRole('tab', { name: 'Your units' }));
    expect(await screen.findByRole('heading', { name: 'Finance', level: 2 })).toBeInTheDocument();
  });

  it('opens someone who answers only for business roles on Role portfolios, on their first role, without a units tab', async () => {
    mount({ contexts: [], contextIds: [], tree: [] });
    const tab = await portfolioTab();
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(within(tab.parentElement).getAllByRole('tab').map(t => t.textContent)).toEqual(['Role portfolios']);
    expect(await screen.findByRole('tab', { name: 'Composition review' })).toBeInTheDocument();
    expect(nav().getByRole('button', { name: /Finance controller/ })).toHaveAttribute('aria-current', 'true');
  });

  it('files each role under the light name of its portfolio, and a role in none under Default portfolio, last', async () => {
    const { user } = mount();
    await user.click(await portfolioTab());
    const trails = nav().getAllByRole('list', { name: 'Part of' }).map(l => l.textContent);
    expect(trails).toEqual(['Finance roles', 'Default portfolio']);
    expect(within(nav().getByRole('list', { name: 'Your business roles in Finance roles' })).getAllByRole('button').map(b => b.textContent))
      .toEqual(['Finance controllerAccountable']);
    expect(within(nav().getByRole('list', { name: 'Your business roles in Default portfolio' })).getAllByRole('button').map(b => b.textContent))
      .toEqual(['Payroll clerkResponsible']);
    // The portfolio's name is not a link: it is outside their scope.
    expect(within(nav().getAllByRole('list', { name: 'Part of' })[0]).queryByRole('button')).toBeNull();
  });

  it('leaves out a role in a portfolio they hold: it opens from that portfolio', async () => {
    const { user } = mount({
      contextIds: [UNIT, HELD_PORTFOLIO],
      businessRoles: [...ROLES, { id: THIRD, displayName: 'Treasury', role: 'Responsible', portfolioId: HELD_PORTFOLIO.toUpperCase(), portfolioName: 'Treasury roles' }],
    });
    await user.click(await portfolioTab());
    expect(nav().queryByText('Treasury')).toBeNull();
    expect(nav().queryByText('Treasury roles')).toBeNull();
    expect(nav().getByText('Finance controller')).toBeInTheDocument();
  });

  it('opens the first role on its Composition review, where they may sign off', async () => {
    const { user, posts } = mount();
    await user.click(await portfolioTab());
    expect(await screen.findByRole('tab', { name: 'Composition review' })).toHaveAttribute('aria-selected', 'true');
    const form = await screen.findByRole('form', { name: 'Your review' });
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(posts).toEqual([[`/api/access-package/${ROLE}/composition-reviews`, { notes: '', signedOff: true }]]));
  });

  it('opens another role from under its portfolio, and the tab stays lit', async () => {
    const { user, authFetch } = mount();
    await user.click(await portfolioTab());
    await user.click(nav().getByRole('button', { name: /Payroll clerk/ }));
    await waitFor(() => expect(authFetch.mock.calls.some(([u]) => String(u).endsWith(`/api/access-package/${SECOND}/composition-reviews`))).toBe(true));
    expect(nav().getByRole('button', { name: /Payroll clerk/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('tab', { name: 'Role portfolios' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows no form when the API says they may not review (the relative permission is off)', async () => {
    const { user } = mount({ canReview: false });
    await user.click(await portfolioTab());
    await screen.findByTestId('sign-off-status');
    expect(screen.queryByRole('form', { name: 'Your review' })).toBeNull();
  });

  it('has no Composition review while the experimental feature is off', async () => {
    const { user } = mount({ flags: {} });
    await user.click(await portfolioTab());
    await screen.findByRole('tab', { name: /Resources/ });
    expect(screen.queryByRole('tab', { name: 'Composition review' })).toBeNull();
  });

  it('goes back to the organisation, on its unit', async () => {
    const { user } = mount();
    await user.click(await portfolioTab());
    await screen.findByRole('tab', { name: 'Composition review' });
    await user.click(screen.getByRole('tab', { name: 'Organisation' }));
    expect(nav().queryByText('Finance controller')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Organisation' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'Finance', level: 2 })).toBeInTheDocument();
  });
});
