// @vitest-environment jsdom
// A review campaign asks the owner to review a business role: the notice they
// get after signing in, the mark on the role, and the way from there into the
// review — which asks only the steps the campaign asks and answers the request.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement as h } from 'react';
import ContextOwnerPage from './ContextOwnerPage';
import { ReviewRequestsBanner } from './contextOwner/ReviewRequestsBanner';
import { renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent } from '@ui/test-utils/renderWithProviders';

const ROLE = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const ROLES = [
  { id: ROLE, displayName: 'Finance controller', role: 'Accountable', portfolioId: null, portfolioName: null },
  { id: OTHER, displayName: 'Payroll clerk', role: 'Accountable', portfolioId: null, portfolioName: null },
];
const request = (over = {}) => ({
  id: 'q-1', roleId: ROLE, roleName: 'Finance controller', campaignId: 'c1', campaignName: 'Yearly role review',
  steps: ['contents'], dueAt: '2030-12-31T23:59:59Z', overdue: false, ...over,
});
const REVIEWS = (asked) => ({
  reviews: [], latestReview: null, canReview: true, request: asked,
  steps: ['ownership', 'lifecycle', 'contents'], verdicts: ['good', 'needsChange', 'notUnderstood'],
  current: { type: { control: 'Manual' }, resources: [], owners: [] },
});

function mount({ requests = [request()], businessRoles = ROLES, flags = { compositionReview: true } } = {}) {
  global.fetch = vi.fn(async (u) => jsonResponse(String(u).includes('/api/features') ? flags : {}));
  const state = { requests, posts: [], asked: [] };
  const authFetch = makeAuthFetch((url, opts = {}) => {
    const u = String(url);
    if (u === '/api/review-requests/mine') { state.asked.push(u); return { requests: state.requests }; }
    if (u.includes('/api/risk-scores/')) return jsonResponse(null, { ok: false, status: 404 });
    if (u.endsWith('/composition-reviews')) {
      const id = u.split('/')[3];
      if (opts.method === 'POST') {
        state.posts.push(JSON.parse(opts.body));
        state.requests = state.requests.filter(q => q.roleId !== id);
        return jsonResponse({ id: 'new' }, { status: 201 });
      }
      return REVIEWS(state.requests.find(q => q.roleId === id) ?? null);
    }
    const role = ROLES.find(r => u.endsWith(`/api/access-package/${r.id}`));
    if (role) return { attributes: { id: role.id, displayName: role.displayName }, accessModel: { waysIn: ['Request'], waysOut: ['Review'], control: 'Manual' }, assignmentCount: 3, groupCount: 1 };
    if (u.endsWith('/resource-roles')) return [{ childResourceId: 'g1', resourceDisplayName: 'SG-Finance', resourceType: 'Group', roleName: 'Member' }];
    if (/\/api\/access-package\/[^/]+\/(owners|participants|policies|assignments|reviews|requests)/.test(u)) return [];
    return undefined;
  });
  renderWithProviders(h(ContextOwnerPage), {
    auth: { authFetch, authEnabled: true, hasWildcard: false, permissions: new Set(), account: { name: 'Carla Cash' }, contextOwner: { contexts: [], contextIds: [], businessRoles } },
  });
  return { state, user: userEvent.setup() };
}

afterEach(() => vi.restoreAllMocks());
const banner = () => screen.findByTestId('review-requests-banner');

describe('an owner a review campaign asks', () => {
  it('reads right after signing in that a review waits, by when and where', async () => {
    mount();
    const notice = await banner();
    expect(notice).toHaveTextContent('1 business role is waiting for your review');
    expect(notice).toHaveTextContent(/Due by .*2030\./);
    expect(notice).toHaveTextContent('You find them under Role portfolios.');
    expect(within(notice).getByRole('button', { name: 'Review Finance controller' })).toBeInTheDocument();
  });

  it('marks the role that waits in the list, and no other', async () => {
    mount();
    await banner();
    const nav = within(screen.getByRole('navigation', { name: 'What you answer for' }));
    expect(nav.getByRole('button', { name: /Finance controller/ })).toHaveTextContent('Review');
    expect(within(nav.getByRole('button', { name: /Payroll clerk/ })).queryByTestId('review-waiting')).toBeNull();
  });

  it('goes from the notice into a review of only the steps the campaign asks, and the notice goes once it is signed', async () => {
    const { state, user } = mount();
    // The page opened on the first role; the notice opens the one that waits.
    await user.click(within(await banner()).getByRole('button', { name: 'Review Finance controller' }));
    const onRole = await screen.findByTestId('review-request-notice');
    expect(onRole).toHaveTextContent('A review is waiting for you.');
    expect(onRole).toHaveTextContent('The campaign "Yearly role review" asks you to review this role by');
    await user.click(within(onRole).getByRole('button', { name: 'Start the review' }));

    const wizard = await screen.findByTestId('review-wizard');
    expect(within(wizard).queryByRole('region', { name: 'Who answers for this role now' })).toBeNull();
    expect(await within(wizard).findByText('SG-Finance')).toBeInTheDocument();
    await user.click(within(wizard).getByRole('radio', { name: 'Good' }));
    await user.click(within(wizard).getByRole('button', { name: 'Next' }));
    await user.click(within(wizard).getByRole('button', { name: 'Sign and finish the review' }));

    await waitFor(() => expect(state.posts).toEqual([{ steps: [{ step: 'contents', verdict: 'good', remark: '' }], notes: '' }]));
    await waitFor(() => expect(screen.queryByTestId('review-requests-banner')).toBeNull());
    expect(state.asked.length).toBeGreaterThan(1);
  });

  it('has no notice on a role nobody asks them to review', async () => {
    const { user } = mount();
    await banner();
    await user.click(within(screen.getByRole('navigation', { name: 'What you answer for' })).getByRole('button', { name: /Payroll clerk/ }));
    await screen.findByText('Who answers for this role');
    await waitFor(() => expect(screen.queryByTestId('review-request-notice')).toBeNull());
  });

  it('sees no notice while nothing is asked', async () => {
    const { state } = mount({ requests: [] });
    await screen.findByRole('navigation', { name: 'What you answer for' });
    await waitFor(() => expect(state.asked).toHaveLength(1));
    expect(screen.queryByTestId('review-requests-banner')).toBeNull();
  });

  it('is not asked at all while Composition review is off', async () => {
    const { state } = mount({ flags: {} });
    await screen.findByRole('navigation', { name: 'What you answer for' });
    expect(state.asked).toEqual([]);
    expect(screen.queryByTestId('review-requests-banner')).toBeNull();
  });
});

describe('the notice itself', () => {
  const show = (requests, roles = ROLES) => {
    const onOpenRole = vi.fn();
    renderWithProviders(h(ReviewRequestsBanner, { requests, roles, onOpenRole }));
    return { onOpenRole, user: userEvent.setup() };
  };

  it('is nothing without requests', () => {
    show([]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('hands the role to open, as the page knows it', async () => {
    const { onOpenRole, user } = show([request()]);
    await user.click(screen.getByRole('button', { name: 'Review Finance controller' }));
    expect(onOpenRole).toHaveBeenCalledWith(ROLES[0]);
  });

  it('says when every review is past its date, and when only some are', () => {
    show([request({ overdue: true })]);
    expect(screen.getByRole('status')).toHaveTextContent('Past the date it was due.');
  });

  it('counts the late ones among several', () => {
    show([request({ overdue: true }), request({ id: 'q-2', roleId: OTHER, roleName: 'Payroll clerk' })]);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('2 business roles are waiting for your review');
    expect(notice).toHaveTextContent('1 past the date it was due.');
  });

  it('names a role the owner cannot open, without a button', () => {
    show([request()], []);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Finance controller (you cannot open this role yet)');
    expect(within(notice).queryByRole('button')).toBeNull();
  });

  it('shows a role two campaigns ask about once, and says how many more there are past six', () => {
    const many = Array.from({ length: 8 }, (_, i) => request({ id: `q-${i}`, roleId: `role-${i}`, roleName: `Role ${i}` }));
    show([...many, request({ id: 'dup', roleId: 'ROLE-0', roleName: 'Role 0' })], []);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('8 business roles are waiting for your review');
    expect(notice).toHaveTextContent('Role 5');
    expect(notice).not.toHaveTextContent('Role 6');
    expect(notice).toHaveTextContent('and 2 more');
  });
});
