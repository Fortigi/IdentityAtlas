// @vitest-environment jsdom
//
// Mount tests for the Compare tab. Ann and Bob share one group, differ on a
// second and on their job title, and have the same department — so a page that
// showed everything, or showed nothing, or lined rows up by column position
// instead of by key, fails at least one assertion.

import { describe, it, expect, vi } from 'vitest';
import EntityComparePage from './EntityComparePage';
import {
  renderWithProviders, makeAuthFetch, jsonResponse, screen, waitFor, within, userEvent,
} from '@ui/test-utils/renderWithProviders';

const ANN = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const CAT = 'cccccccc-0000-4000-8000-000000000003';

const held = (g, label, detail = 'Direct') => ({ key: `heldResources:${g}|Direct`, group: 'Groups', label, kind: 'resource', id: g, detail });

const SNAPSHOTS = {
  [ANN]: { id: ANN, omitted: 0, snapshot: { exists: true, deleted: false,
    attributes: { displayName: 'Ann Analyst', userPrincipalName: 'ann@x', department: 'Finance', jobTitle: 'Analyst' },
    relationships: [held('g1', 'Finance Team'), held('g2', 'Payroll Admins')] } },
  [BOB]: { id: BOB, omitted: 0, snapshot: { exists: true, deleted: true,
    attributes: { displayName: 'Bob Builder', userPrincipalName: 'bob@x', department: 'Finance', jobTitle: 'Senior Analyst' },
    relationships: [held('g1', 'Finance Team')] } },
  [CAT]: { id: CAT, omitted: 2500, snapshot: { exists: true, deleted: false,
    attributes: { displayName: 'Cat Clerk', department: 'Finance' }, relationships: [] } },
};

function handler(url) {
  const m = /\/api\/user\/([^/]+)\/snapshot$/.exec(url);
  if (m) return SNAPSHOTS[m[1]] ? jsonResponse(SNAPSHOTS[m[1]]) : jsonResponse({ error: 'Not found' }, { ok: false, status: 404 });
  if (url.startsWith('/api/users?search=cat')) return jsonResponse({ data: [{ id: CAT, displayName: 'Cat Clerk', principalType: 'User' }] });
  return jsonResponse({ data: [] });
}

function mount(compareId) {
  const authFetch = makeAuthFetch(handler);
  const props = { compareId, onOpenDetail: vi.fn(), onReplaceRoute: vi.fn(), onCacheData: vi.fn() };
  const view = renderWithProviders(<EntityComparePage {...props} />, {
    auth: { permissions: new Set(), hasWildcard: true, permissionsLoaded: true, authFetch },
  });
  return { ...props, authFetch, view, user: userEvent.setup() };
}

const rowWith = (text) => screen.getByText(text).closest('li');

describe('EntityComparePage', () => {
  it('fetches one snapshot per user and shows only the differences by default', async () => {
    const { authFetch } = mount(`${ANN},${BOB}`);
    expect(await screen.findByText('Payroll Admins')).toBeInTheDocument();
    const urls = authFetch.mock.calls.map(([u]) => u);
    expect(urls).toContain(`/api/user/${ANN}/snapshot`);
    expect(urls).toContain(`/api/user/${BOB}/snapshot`);

    // Payroll: Ann has it, Bob does not → one row, gap in Bob's column.
    const payroll = rowWith('Payroll Admins');
    expect(payroll).toHaveAttribute('data-status', 'differs');
    expect(within(payroll).getByLabelText('not held')).toBeInTheDocument();
    // Job title differs; the shared group, the same department and the names are hidden.
    expect(rowWith('Senior Analyst')).toHaveAttribute('data-status', 'differs');
    expect(screen.queryByText('Finance Team')).not.toBeInTheDocument();
    expect(screen.queryByText('Department')).not.toBeInTheDocument();
    expect(screen.queryByText('ann@x')).not.toBeInTheDocument();
    // Differ: job title + Payroll. Same: department + Finance Team. Names and UPNs don't count.
    expect(screen.getByLabelText('Summary of the comparison')).toHaveTextContent('2 differ');
    expect(screen.getByLabelText('Summary of the comparison')).toHaveTextContent('2 the same');
  });

  it('shows the shared rows and the personal fields when the switches are turned off', async () => {
    const { user } = mount(`${ANN},${BOB}`);
    await screen.findByText('Payroll Admins');
    await user.click(screen.getByRole('checkbox', { name: 'Only show differences' }));
    const shared = screen.getAllByText('Finance Team')[0].closest('li');
    expect(shared).toHaveAttribute('data-status', 'same');
    expect(within(shared).getAllByText('Finance Team')).toHaveLength(2);
    expect(screen.queryByText('ann@x')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Hide names, e-mail and IDs' }));
    expect(screen.getByText('ann@x')).toBeInTheDocument();
  });

  it('names the tab after the users and notes a user deleted in the source', async () => {
    const { onCacheData } = mount(`${ANN},${BOB}`);
    await waitFor(() => expect(onCacheData).toHaveBeenCalledWith(`${ANN},${BOB}`, 'compare', { displayName: 'Compare: Ann Analyst · Bob Builder' }));
    expect(screen.getByText('Bob Builder is deleted in the source.')).toBeInTheDocument();
  });

  it('adds a picked user to the tab address, and removes one', async () => {
    const { user, onReplaceRoute } = mount(`${ANN},${BOB}`);
    await screen.findByText('Payroll Admins');
    await user.type(screen.getByRole('textbox', { name: /Users to compare/ }), 'cat');
    await user.click(await screen.findByRole('button', { name: /Cat Clerk/ }, { timeout: 5000 }));
    expect(onReplaceRoute).toHaveBeenCalledWith(`${ANN},${BOB},${CAT}`);
    await user.click(screen.getByRole('button', { name: 'Remove Ann Analyst' }));
    expect(onReplaceRoute).toHaveBeenLastCalledWith(BOB);
  });

  it('asks for more users when fewer than two are picked', async () => {
    const { authFetch } = mount(ANN);
    expect(screen.getByText('Pick one or two more users to compare.')).toBeInTheDocument();
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(`/api/user/${ANN}/snapshot`));
    expect(screen.queryByLabelText('Summary of the comparison')).not.toBeInTheDocument();
  });

  it('with three users full, the search is closed; an unloadable user and a capped one get a note', async () => {
    const missing = 'dddddddd-0000-4000-8000-000000000004';
    mount(`${ANN},${CAT},${missing}`);
    expect(await screen.findByText(`${missing} could not be loaded (Not found).`)).toBeInTheDocument();
    expect(screen.getByText(/Cat Clerk has 2[.,]500 more relationships/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Users to compare/ })).toBeDisabled();
    // The two that loaded are still compared.
    expect(screen.getByText('Payroll Admins')).toBeInTheDocument();
  });

  it('opens a relationship\'s own page from its cell', async () => {
    const { user, onOpenDetail } = mount(`${ANN},${BOB}`);
    await user.click(await screen.findByRole('button', { name: 'Payroll Admins' }));
    expect(onOpenDetail).toHaveBeenCalledWith('resource', 'g2', 'Payroll Admins');
  });
});
