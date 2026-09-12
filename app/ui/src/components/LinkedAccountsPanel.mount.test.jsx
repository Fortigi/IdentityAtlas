// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import LinkedAccountsPanel from './LinkedAccountsPanel';
import {
  renderWithProviders,
  screen,
  within,
  userEvent,
} from '@ui/test-utils/renderWithProviders';

// A scored (account-linking) member: linkConfidence present → Confirm/Remove.
const scored = {
  principalId: 'p-1',
  displayName: 'Dana Doe',
  userPrincipalName: 'dana@corp.com',
  systemId: 1,
  systemDisplayName: 'Entra ID',
  accountType: 'Regular',
  userAccountEnabled: true,
  isPrimary: true,
  linkConfidence: 92,
};

// A crawler/source-linked member: no confidence → "Linked from source".
const sourceLinked = {
  principalId: 'p-2',
  displayName: 'ddoe-adm',
  userPrincipalName: 'ddoe-adm@corp.com',
  systemId: 2,
  systemDisplayName: 'Active Directory',
  accountType: 'Admin',
  userAccountEnabled: false,
  linkConfidence: null,
};

function renderPanel(props = {}) {
  return renderWithProviders(h(LinkedAccountsPanel, {
    members: [scored, sourceLinked],
    busyMember: null,
    onOverride: () => {},
    onOpenDetail: () => {},
    ...props,
  }));
}

// Row lookup by its Account cell, so a column re-order doesn't silently pass.
function rowFor(name) {
  return screen.getByRole('button', { name }).closest('tr');
}

describe('LinkedAccountsPanel (mounted)', () => {
  it('renders the System | Account | Enabled | Type header', () => {
    renderPanel();
    const headers = screen.getAllByRole('columnheader').map(th => th.textContent);
    expect(headers).toEqual(['System', 'Account', 'Enabled', 'Type', 'Actions']);
  });

  it('shows each account under its own source system and account type', () => {
    renderPanel();
    const cells = within(rowFor('Dana Doe')).getAllByRole('cell').map(td => td.textContent);
    expect(cells[0]).toBe('Entra ID');
    expect(cells[3]).toBe('Regular');
    expect(within(rowFor('ddoe-adm')).getAllByRole('cell')[0]).toHaveTextContent('Active Directory');
  });

  it('renders Yes for an enabled account and No for a disabled one', () => {
    renderPanel();
    expect(within(rowFor('Dana Doe')).getAllByRole('cell')[2]).toHaveTextContent('Yes');
    expect(within(rowFor('ddoe-adm')).getAllByRole('cell')[2]).toHaveTextContent('No');
  });

  it('falls back to the link-time snapshot when the live value is missing', () => {
    renderPanel({
      members: [{ ...scored, userAccountEnabled: null, accountEnabled: true }],
    });
    expect(within(rowFor('Dana Doe')).getAllByRole('cell')[2]).toHaveTextContent('Yes');
  });

  it('renders an em dash for System, Enabled and Type when all are unknown', () => {
    renderPanel({
      members: [{
        principalId: 'p-3', displayName: 'orphan@hr', linkConfidence: 40,
        systemDisplayName: null, accountType: null,
        userAccountEnabled: null, accountEnabled: null,
      }],
    });
    const cells = within(rowFor('orphan@hr')).getAllByRole('cell').map(td => td.textContent);
    expect([cells[0], cells[2], cells[3]]).toEqual(['—', '—', '—']);
  });

  it('shows the UPN and primary marker under the account name', () => {
    renderPanel();
    expect(rowFor('Dana Doe')).toHaveTextContent('dana@corp.com · primary');
    expect(rowFor('ddoe-adm')).toHaveTextContent('ddoe-adm@corp.com');
    expect(rowFor('ddoe-adm')).not.toHaveTextContent('primary');
  });

  it('marks a primary account that has no UPN', () => {
    renderPanel({ members: [{ ...scored, userPrincipalName: null }] });
    const row = rowFor('Dana Doe');
    expect(row).toHaveTextContent('primary');
    expect(row).not.toHaveTextContent('·');
  });

  it('opens the account detail when the account name is clicked', async () => {
    const onOpenDetail = vi.fn();
    renderPanel({ onOpenDetail });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dana Doe' }));
    expect(onOpenDetail).toHaveBeenCalledWith('user', 'p-1', 'Dana Doe');
  });

  it('offers Confirm and Remove on a scored link and fires the override', async () => {
    const onOverride = vi.fn();
    renderPanel({ onOverride });
    const user = userEvent.setup();

    const row = within(rowFor('Dana Doe'));
    await user.click(row.getByRole('button', { name: 'Confirm' }));
    expect(onOverride).toHaveBeenCalledWith('p-1', 'confirmed');

    await user.click(row.getByRole('button', { name: 'Remove' }));
    expect(onOverride).toHaveBeenCalledWith('p-1', 'rejected');
  });

  it('shows the override badge and an Undo that clears it', async () => {
    const onOverride = vi.fn();
    renderPanel({ members: [{ ...scored, analystOverride: 'confirmed' }], onOverride });

    const row = within(rowFor('Dana Doe'));
    expect(row.getByText('confirmed')).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Confirm' })).toBeNull();

    await userEvent.setup().click(row.getByRole('button', { name: 'Undo' }));
    expect(onOverride).toHaveBeenCalledWith('p-1', 'clear');
  });

  it('renders the rejected override badge', () => {
    renderPanel({ members: [{ ...scored, analystOverride: 'rejected' }] });
    expect(within(rowFor('Dana Doe')).getByText('rejected')).toBeInTheDocument();
  });

  it('renders an unrecognised override with the neutral badge', () => {
    renderPanel({ members: [{ ...scored, analystOverride: 'moved' }] });
    expect(within(rowFor('Dana Doe')).getByText('moved')).toBeInTheDocument();
  });

  it('disables the action buttons for the busy member only', () => {
    renderPanel({ busyMember: 'p-1' });
    expect(within(rowFor('Dana Doe')).getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('shows the confidence bar for a scored link', () => {
    renderPanel();
    expect(within(rowFor('Dana Doe')).getByText('92%')).toBeInTheDocument();
  });

  it('shows "Linked from source" instead of actions for an unscored link', () => {
    renderPanel();
    const row = within(rowFor('ddoe-adm'));
    expect(row.getByText('Linked from source')).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(row.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('renders the empty state and no table when there are no members', () => {
    renderPanel({ members: [] });
    expect(screen.getByText('No linked accounts.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
