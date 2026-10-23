// @vitest-environment jsdom
//
// A context owner's page: their context(s), read-only, with the report card.
// The context is a MANUAL unit on purpose — for an analyst that variant shows
// Edit, the member picker and Remove buttons, so their absence here is the
// read-only mode at work, not a context that never had them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ContextOwnerPage from './ContextOwnerPage';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, userEvent, within,
} from '@ui/test-utils/renderWithProviders';

const UNIT = 'aaaaaaaa-0000-4000-8000-000000000001';
const SECOND = 'aaaaaaaa-0000-4000-8000-000000000004';
const RESOURCES = 'aaaaaaaa-0000-4000-8000-000000000002'; // variant, in scope
const ACCOUNTS = 'aaaaaaaa-0000-4000-8000-000000000003';  // variant of a variant, NOT in scope

const unit = (id, displayName, extra = {}) => ({
  attributes: {
    id, displayName, variant: 'manual', targetType: 'Identity', contextType: 'Department',
    contextCategory: 'OrganizationalUnit', directMemberCount: 1, totalMemberCount: 1, ...extra,
  },
  subContexts: [{ id: 'aaaaaaaa-0000-4000-8000-0000000000c1', displayName: 'Payroll team', memberCount: 1 }],
});

const relationships = [
  { id: 'r1', relationshipType: 'SameUnitAs', relatedContextId: RESOURCES, relatedDisplayName: 'Finance', relatedTargetType: 'Resource', relatedTotalMemberCount: 4 },
  { id: 'r2', relationshipType: 'SameUnitAs', relatedContextId: ACCOUNTS, relatedDisplayName: 'Finance', relatedTargetType: 'Principal', relatedTotalMemberCount: 9 },
];

function api(unitExtra = {}) {
  return makeAuthFetch((url) => {
    const u = String(url);
    if (u.includes('/roles/suggestion')) return { principalId: 'p-guess', displayName: 'Guessed Person', reason: 'manages most members' };
    if (u.includes('/roles')) return [{ id: 'role-1', role: 'Responsible', principalId: 'p-1', displayName: 'Rita Responsible', addedBy: 'analyst' }];
    if (u.includes(`${RESOURCES}/relationships`)) {
      return [{ id: 'r1', relationshipType: 'SameUnitAs', relatedContextId: UNIT, relatedDisplayName: 'Finance', relatedTargetType: 'Identity', relatedTotalMemberCount: 1 }];
    }
    if (u.includes('/relationships')) return relationships;
    if (u.includes('/members')) return { total: 1, data: [{ id: 'm-1', displayName: 'Alice Member', principalType: 'User', addedBy: 'analyst' }] };
    if (u.includes('/timeline')) return { events: [] };
    if (u.includes('/risk-scores/')) return jsonResponse({}, { ok: false, status: 404 });
    if (u.endsWith(`/api/contexts/${UNIT}`)) return unit(UNIT, 'Finance', unitExtra);
    if (u.endsWith(`/api/contexts/${SECOND}`)) return unit(SECOND, 'Payroll');
    if (u.endsWith(`/api/contexts/${RESOURCES}`)) return unit(RESOURCES, 'Finance', { targetType: 'Resource' });
    if (u.endsWith(`/api/contexts/${ACCOUNTS}`)) return jsonResponse({ error: 'Context owners can only open their own context' }, { ok: false, status: 403 });
    return undefined;
  });
}

const ctx = (id, displayName, role) => ({ id, displayName, role, contextCategory: 'OrganizationalUnit', targetType: 'Identity' });

function mount(contexts, contextIds = [UNIT, RESOURCES, SECOND], unitExtra = {}) {
  const authFetch = api(unitExtra);
  const logout = vi.fn();
  renderWithProviders(<ContextOwnerPage />, {
    auth: {
      authFetch, logout, authEnabled: true, hasWildcard: false, permissions: new Set(),
      account: { name: 'Olivia Owner', username: 'olivia@example.com' },
      contextOwner: { contexts, contextIds },
    },
  });
  return { authFetch, logout };
}

const fetched = (authFetch, fragment) => authFetch.mock.calls.some(([u]) => String(u).includes(fragment));

beforeEach(() => {
  global.fetch = vi.fn(async () => jsonResponse({ riskScoring: true }));
});
afterEach(() => vi.restoreAllMocks());

describe('ContextOwnerPage — one context', () => {
  it('shows that context directly, with no list beside it, and the signed-in user', async () => {
    mount([ctx(UNIT, 'Finance', 'Accountable')]);
    expect(await screen.findByRole('heading', { name: 'Finance', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Your contexts' })).not.toBeInTheDocument();
    expect(screen.getByText('Olivia Owner')).toBeInTheDocument();
  });

  it('signs out from the header', async () => {
    const { logout } = mount([ctx(UNIT, 'Finance', 'Accountable')]);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('is read-only: no Edit, no Open as page, no pencils, no member editing, no best guess', async () => {
    const { authFetch } = mount([ctx(UNIT, 'Finance', 'Responsible')]);
    await screen.findByText('Alice Member');
    expect(await screen.findByText('Rita Responsible')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open as page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit (Accountable|Responsible)$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('best-guess')).not.toBeInTheDocument();
    expect(fetched(authFetch, '/roles/suggestion')).toBe(false);
  });

  it('does not link to pages the owner cannot open: members, people, sub-contexts', async () => {
    mount([ctx(UNIT, 'Finance', 'Responsible')]);
    const member = await screen.findByText('Alice Member');
    expect(member.closest('tr')).not.toHaveClass('cursor-pointer');
    expect(screen.queryByRole('button', { name: 'Rita Responsible' })).not.toBeInTheDocument();
    expect(screen.getByText('Payroll team')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Payroll team/ })).not.toBeInTheDocument();
  });

  it('offers the unit report on a unit of people, without the matrix or the coming-soon surveys', async () => {
    mount([ctx(UNIT, 'Finance', 'Responsible')]);
    const card = await screen.findByTestId('action-download-unit-report');
    expect(within(card).getByRole('button', { name: 'Download (Excel)' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View in matrix/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-download-report')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-manager-survey')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-review-members')).not.toBeInTheDocument();
  });

  it('shows no Actions on a unit of resources: no matrix (out of reach) and no report for it', async () => {
    mount([ctx(UNIT, 'Finance', 'Responsible')], undefined, { targetType: 'Resource' });
    await screen.findByText('Alice Member');
    expect(screen.queryByRole('region', { name: 'Actions' })).not.toBeInTheDocument();
  });

  it('offers the report on an application they own, still without the matrix', async () => {
    mount([ctx(UNIT, 'Finance', 'Accountable')], undefined, { contextCategory: 'LogicalApplication', targetType: 'Resource' });
    const card = await screen.findByTestId('action-download-report');
    expect(within(card).getByRole('button', { name: 'Download (Excel)' })).toBeInTheDocument();
    expect(screen.queryByTestId('action-view-in-matrix')).not.toBeInTheDocument();
  });

  it('has no Copy link, and names the parent without reading it', async () => {
    const PARENT = 'aaaaaaaa-0000-4000-8000-0000000000f1';
    const { authFetch } = mount([ctx(UNIT, 'Finance', 'Accountable')], undefined,
      { parentContextId: PARENT, parentDisplayName: 'Company' });
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByText('Company')).toBeInTheDocument();
    expect(within(crumbs).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
    expect(fetched(authFetch, PARENT)).toBe(false);
  });

  it('opens an in-scope variant in place, and ignores one outside the scope', async () => {
    const { authFetch } = mount([ctx(UNIT, 'Finance', 'Responsible')]);
    const variants = await screen.findByRole('group', { name: 'This unit as' });

    await userEvent.click(within(variants).getByRole('button', { name: 'Accounts 9' }));
    expect(screen.getByRole('group', { name: 'This unit as' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'This unit as' })).getByRole('button', { name: /^People/ }))
      .toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(within(variants).getByRole('button', { name: 'Resources 4' }));
    await waitFor(() => {
      const group = screen.getByRole('group', { name: 'This unit as' });
      expect(within(group).getByRole('button', { name: /^Resources/ })).toHaveAttribute('aria-pressed', 'true');
    });
    expect(fetched(authFetch, `/api/contexts/${RESOURCES}/members`)).toBe(true);
    expect(fetched(authFetch, `/api/contexts/${ACCOUNTS}/members`)).toBe(false);
  });
});

describe('ContextOwnerPage — several contexts', () => {
  it('lists them with their role, shows the first, and switches on click', async () => {
    const { authFetch } = mount([ctx(UNIT, 'Finance', 'Accountable'), ctx(SECOND, 'Payroll', 'Responsible')]);
    const nav = screen.getByRole('navigation', { name: 'Your contexts' });
    const finance = within(nav).getByRole('button', { name: /Finance/ });
    expect(finance).toHaveAttribute('aria-current', 'true');
    expect(within(finance).getByText('Accountable')).toBeInTheDocument();
    expect(within(within(nav).getByRole('button', { name: /Payroll/ })).getByText('Responsible')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Finance', level: 2 })).toBeInTheDocument();

    await userEvent.click(within(nav).getByRole('button', { name: /Payroll/ }));
    expect(await screen.findByRole('heading', { name: 'Payroll', level: 2 })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /Payroll/ })).toHaveAttribute('aria-current', 'true');
    expect(fetched(authFetch, `/api/contexts/${SECOND}/members`)).toBe(true);
  });
});
