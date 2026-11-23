// @vitest-environment jsdom
//
// The "Business roles" column of an application's resources.

import { describe, it, expect, vi } from 'vitest';
import { MEMBER_TABLE_COLUMNS, visibleMemberColumns } from './ContextRelationshipsTab.helpers';
import { renderWithProviders, screen, userEvent } from '@ui/test-utils/renderWithProviders';

const column = MEMBER_TABLE_COLUMNS.Resource.find(c => c.label === 'Business roles');
const role = (id, displayName, extra = {}) => ({ id, displayName, ...extra });

function Cell({ member, onOpenDetail, onRow = () => {} }) {
  return <div onClick={onRow}>{column.render(member, { onOpenDetail })}</div>;
}

describe('Business roles column', () => {
  it('shows for a page where nothing is in a role, because that is the answer', () => {
    const [shown] = visibleMemberColumns('Resource', [{ id: 'a', businessRoles: [] }]).filter(c => c.label === 'Business roles');
    expect(shown).toBeDefined();
    renderWithProviders(<div>{shown.render({ businessRoles: [] }, {})}</div>);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('is left out when the rows carry no role data at all', () => {
    expect(visibleMemberColumns('Resource', [{ id: 'a' }]).map(c => c.label)).not.toContain('Business roles');
  });

  it('opens a role on its own page without also opening the row', async () => {
    const open = vi.fn();
    const row = vi.fn();
    renderWithProviders(<Cell member={{ businessRoles: [role('r1', 'Finance')] }} onOpenDetail={open} onRow={row} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Finance' }));
    expect(open).toHaveBeenCalledWith('access-package', 'r1', 'Finance');
    expect(row).not.toHaveBeenCalled();
  });

  it('names a role the reader may not open, without a link', () => {
    renderWithProviders(<Cell member={{ businessRoles: [role('r1', 'Finance', { accessible: false })] }} onOpenDetail={vi.fn()} />);
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Finance/ })).toBeNull();
  });

  it('shows three roles in full, and names the rest in a "more" hint', () => {
    const roles = ['A', 'B', 'C', 'D', 'E'].map(n => role(n, `Role ${n}`));
    renderWithProviders(<Cell member={{ businessRoles: roles }} onOpenDetail={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.getByText('+2 more')).toHaveAttribute('title', 'Role D, Role E');
  });

  it('shows exactly three without a hint', () => {
    const roles = ['A', 'B', 'C'].map(n => role(n, `Role ${n}`));
    renderWithProviders(<Cell member={{ businessRoles: roles }} onOpenDetail={vi.fn()} />);
    expect(screen.queryByText(/more/)).toBeNull();
  });
});
