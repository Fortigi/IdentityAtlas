// @vitest-environment jsdom
//
// A context owner who also answers for business roles: the Your business roles
// view on their own page, and the Composition review they may sign off there.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ContextOwnerPage from '@ui/components/ContextOwnerPage';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

const UNIT = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROLE = 'bbbbbbbb-0000-4000-8000-000000000001';
const SECOND = 'bbbbbbbb-0000-4000-8000-000000000002';
const ROLES = [
  { id: ROLE, displayName: 'Finance controller', role: 'Accountable' },
  { id: SECOND, displayName: 'Payroll clerk', role: 'Responsible' },
];

const roleBody = (id, displayName) => ({
  attributes: { id, displayName },
  accessModel: { waysIn: ['Request'], waysOut: ['Review'], control: 'Manual', reviewRequired: true, reviewGap: false },
  assignmentCount: 3, groupCount: 1,
});

function api({ canReview = true } = {}) {
  const posts = [];
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
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

function mount({ businessRoles = ROLES, flags = { compositionReview: true }, ...opts } = {}) {
  global.fetch = vi.fn(async (u) => jsonResponse(String(u).includes('/api/features') ? flags : {}));
  const { authFetch, posts } = api(opts);
  renderWithProviders(<ContextOwnerPage />, {
    auth: {
      authFetch, authEnabled: true, hasWildcard: false, permissions: new Set(),
      account: { name: 'Carla Cash' },
      contextOwner: { contexts: [{ id: UNIT, displayName: 'Finance', role: 'Accountable', contextCategory: 'OrganizationalUnit', targetType: 'Identity' }], contextIds: [UNIT], businessRoles },
    },
  });
  return { authFetch, posts, user: userEvent.setup() };
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.restoreAllMocks());

describe('Your business roles', () => {
  it('is not offered to an owner who answers for no business role', async () => {
    mount({ businessRoles: [] });
    await screen.findAllByText('Finance');
    expect(screen.queryByRole('tab', { name: 'Your business roles' })).toBeNull();
  });

  it('opens on the contexts, and lists the roles they answer for — and only those — with what they are', async () => {
    const { user } = mount();
    expect(await screen.findByRole('tab', { name: 'Your contexts' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Your business roles' }));
    const list = await screen.findByRole('navigation', { name: 'Your business roles' });
    expect(within(list).getAllByRole('button').map(b => b.textContent)).toEqual(['Finance controllerAccountable', 'Payroll clerkResponsible']);
    expect(within(list).getByRole('button', { name: /Finance controller/ })).toHaveAttribute('aria-current', 'true');
  });

  it('opens the first role on its Composition review, where they may sign off', async () => {
    const { user, posts } = mount();
    await user.click(await screen.findByRole('tab', { name: 'Your business roles' }));
    expect(await screen.findByRole('tab', { name: 'Composition review' })).toHaveAttribute('aria-selected', 'true');
    const form = await screen.findByRole('form', { name: 'Your review' });
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(posts).toEqual([[`/api/access-package/${ROLE}/composition-reviews`, { notes: '', signedOff: true }]]));
  });

  it('opens another role from the list', async () => {
    const { user, authFetch } = mount();
    await user.click(await screen.findByRole('tab', { name: 'Your business roles' }));
    await user.click(within(await screen.findByRole('navigation', { name: 'Your business roles' })).getByRole('button', { name: /Payroll clerk/ }));
    await waitFor(() => expect(authFetch.mock.calls.some(([u]) => String(u).endsWith(`/api/access-package/${SECOND}/composition-reviews`))).toBe(true));
  });

  it('shows no form when the API says they may not review (the relative permission is off)', async () => {
    const { user } = mount({ canReview: false });
    await user.click(await screen.findByRole('tab', { name: 'Your business roles' }));
    await screen.findByTestId('sign-off-status');
    expect(screen.queryByRole('form', { name: 'Your review' })).toBeNull();
  });

  it('has no Composition review while the experimental feature is off', async () => {
    const { user } = mount({ flags: {} });
    await user.click(await screen.findByRole('tab', { name: 'Your business roles' }));
    await screen.findByRole('tab', { name: /Resources/ });
    expect(screen.queryByRole('tab', { name: 'Composition review' })).toBeNull();
  });

  it('goes back to the contexts', async () => {
    const { user } = mount();
    await user.click(await screen.findByRole('tab', { name: 'Your business roles' }));
    await screen.findByRole('navigation', { name: 'Your business roles' });
    await user.click(screen.getByRole('tab', { name: 'Your contexts' }));
    expect(screen.queryByRole('navigation', { name: 'Your business roles' })).toBeNull();
  });
});
