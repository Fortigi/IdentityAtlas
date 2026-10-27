// @vitest-environment jsdom
// A unit's "Proposed roles": folded to how many, opened to one row per saved
// proposed role (read only then), each opening the workbench on that role.
import { describe, it, expect, vi } from 'vitest';
import ProposedRolesSection from './ProposedRolesSection';
import { renderWithProviders, screen, within, userEvent, makeAuthFetch, jsonResponse } from '@ui/test-utils/renderWithProviders';

const LIST = [
  { id: 'inv-1', name: 'First pass', proposals: [{ id: 'p1', name: 'Handler' }] },
  { id: 'inv-2', name: 'Empty', proposals: [] },
];
const INV = {
  id: 'inv-1', name: 'First pass', updatedBy: 'ann', updatedAt: '2026-10-27T09:00:00', marks: [],
  proposals: [{ id: 'p1', name: 'Handler', kind: 'requestable', members: ['i:ann'], entitlements: ['r1', 'r2'] }],
};
const WB = { unit: { displayName: 'Property Claims', accountable: null }, columns: [{ id: 'br', isRole: true }], people: [{ key: 'i:ann', direct: true, accounts: [] }] };

function mount({ list = LIST, workbench = WB } = {}) {
  const onOpenRole = vi.fn();
  const authFetch = makeAuthFetch((url) => {
    if (url === '/api/workbench/investigations/inv-1') return INV;
    if (url === '/api/contexts/u-1/workbench?includeChildren=true') return workbench;
    return undefined;
  });
  renderWithProviders(<ProposedRolesSection id="pr" contextId="u-1" list={list} onOpenRole={onOpenRole} />, { auth: { authFetch } });
  return { onOpenRole, authFetch, user: userEvent.setup() };
}

describe('ProposedRolesSection', () => {
  it('folds to how many, reads nothing until opened, then lists each role and opens the workbench on it', async () => {
    const { onOpenRole, authFetch, user } = mount();
    const region = screen.getByRole('region', { name: 'Proposed roles' });
    expect(region).toHaveTextContent('1 in 1 investigation');
    expect(authFetch).not.toHaveBeenCalled();
    await user.click(within(region).getByRole('button', { name: /^Proposed roles/ }));
    const row = await within(region).findByRole('button', { name: /Handler/ });
    expect(row).toHaveTextContent('Handler · requestable · 1 person · 2 entitlements');
    expect(row).toHaveTextContent('Requestable by anyone');
    expect(row).toHaveTextContent('In “First pass” · saved by ann, 27-10-2026');
    // Only the investigation that holds a role is read.
    expect(authFetch.mock.calls.map(c => c[0])).not.toContain('/api/workbench/investigations/inv-2');
    await user.click(row);
    expect(onOpenRole).toHaveBeenCalledWith('inv-1', 'p1');
  });

  it('shows nothing when no investigation holds a proposed role, or before the list is read', () => {
    const { authFetch } = mount({ list: [LIST[1]] });
    expect(screen.queryByRole('region', { name: 'Proposed roles' })).toBeNull();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('shows why the roles could not be read', async () => {
    const { user } = mount({ workbench: jsonResponse({ error: 'Context not found' }, { ok: false, status: 404 }) });
    await user.click(screen.getByRole('button', { name: /^Proposed roles/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Context not found');
  });
});
